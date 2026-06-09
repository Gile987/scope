// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

interface ServiceDocument {
  _id: string;
  version: number;
  type?: "post-process-handler";
  queue?: string;
  selector?: string;
  autoBackfill?: boolean;
  dependsOn?: string[];
}

type HandlerServiceSeed = Required<ServiceDocument> & {
  type: "post-process-handler";
};

const HANDLER_SERVICES: readonly HandlerServiceSeed[] = [
  {
    _id: "pp-atif",
    type: "post-process-handler",
    version: 2,
    queue: "post-processor-queue",
    selector: "atif",
    autoBackfill: true,
    dependsOn: [],
  },
  {
    _id: "pp-taxonomy",
    type: "post-process-handler",
    version: 1,
    queue: "pp-taxonomy-queue",
    selector: "taxonomy",
    autoBackfill: false,
    dependsOn: ["pp-atif"],
  },
  {
    _id: "pp-report",
    type: "post-process-handler",
    version: 1,
    queue: "report-queue",
    selector: "report",
    autoBackfill: false,
    dependsOn: ["pp-atif", "pp-taxonomy"],
  },
];

export class MigrateServicesToHandlerDag implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const services = db.collection<ServiceDocument>("services");

    await services.deleteOne({ _id: "post-processor" });
    console.log("[018] Deleted legacy post-processor service entry if it existed");

    for (const service of HANDLER_SERVICES) {
      const { _id, ...fields } = service;
      await services.updateOne(
        { _id },
        {
          $set: {
            ...fields,
            dependsOn: [...fields.dependsOn],
          },
        },
        { upsert: true },
      );
      console.log(`[018] Upserted handler service ${_id}`);
    }
  }

  async down(db: Db): Promise<void> {
    const services = db.collection<ServiceDocument>("services");

    await services.deleteMany({ _id: { $in: HANDLER_SERVICES.map((service) => service._id) } });
    console.log("[018-down] Deleted handler service entries");

    await services.updateOne(
      { _id: "post-processor" },
      {
        $set: { version: 2 },
        $unset: {
          type: "",
          queue: "",
          selector: "",
          autoBackfill: "",
          dependsOn: "",
        },
      },
      { upsert: true },
    );
    console.log("[018-down] Restored legacy post-processor service entry");
  }
}
