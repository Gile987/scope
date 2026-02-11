// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Routes, Route } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { RunsList } from "@/pages/RunsList";
import { RunDetail } from "@/pages/RunDetail";
import { SubmitRun } from "@/pages/SubmitRun";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<RunsList />} />
        <Route path="/runs/new" element={<SubmitRun />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Route>
    </Routes>
  );
}
