// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export type Action = "read" | "write" | "delete" | "admin";
export type Permission = `${string}/${string}:${Action}`;
export type UserRole = "user" | "admin";

const ACTIONS: Action[] = ["read", "write", "delete", "admin"];

export function isPermission(value: unknown): value is Permission {
  if (typeof value !== "string") return false;

  const [resource, action, ...extraSegments] = value.split(":");
  if (extraSegments.length > 0) return false;
  if (!resource || !action || !ACTIONS.includes(action as Action)) return false;

  const [namespace, name, ...extraResourceSegments] = resource.split("/");
  if (extraResourceSegments.length > 0) return false;
  return Boolean(namespace && name);
}

export function hasPermission(heldPermissions: readonly Permission[], required: Permission): boolean {
  const requiredParts = parsePermission(required);
  if (!requiredParts) return false;

  return heldPermissions.some((held) => {
    const heldParts = parsePermission(held);
    if (!heldParts) return false;

    return (
      heldParts.namespace === requiredParts.namespace &&
      (heldParts.resource === requiredParts.resource || heldParts.resource === "*") &&
      (heldParts.action === requiredParts.action || heldParts.action === "admin")
    );
  });
}

export function hasEveryPermission(
  heldPermissions: readonly Permission[],
  required: Permission | readonly Permission[] | undefined,
): boolean {
  if (!required) return true;

  const requiredPermissions = Array.isArray(required) ? required : [required];
  return requiredPermissions.every((permission) => hasPermission(heldPermissions, permission));
}

function parsePermission(permission: Permission):
  | { namespace: string; resource: string; action: Action }
  | null {
  const [resourcePart, action, ...extraSegments] = permission.split(":");
  if (extraSegments.length > 0) return null;
  if (!resourcePart || !ACTIONS.includes(action as Action)) return null;

  const [namespace, resource, ...extraResourceSegments] = resourcePart.split("/");
  if (extraResourceSegments.length > 0) return null;
  if (!namespace || !resource) return null;

  return { namespace, resource, action: action as Action };
}
