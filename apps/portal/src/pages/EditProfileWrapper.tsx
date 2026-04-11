// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams } from "react-router-dom";
import { CreateProfile } from "@/pages/CreateProfile";

/** Wrapper that extracts profileId from URL params and passes it as editProfileId */
export function EditProfileWrapper() {
  const { profileId } = useParams<{ profileId: string }>();
  return <CreateProfile editProfileId={profileId} />;
}
