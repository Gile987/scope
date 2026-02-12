// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Routes, Route } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { RunsList } from "@/pages/RunsList";
import { RunDetail } from "@/pages/RunDetail";
import { SubmitRun } from "@/pages/SubmitRun";
import { CriteriaList } from "@/pages/CriteriaList";
import { CriterionDetail } from "@/pages/CriterionDetail";
import { CreateCriterion } from "@/pages/CreateCriterion";
import { CriteriaGraphView } from "@/pages/CriteriaGraphView";
import { Insights } from "@/pages/Insights";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<RunsList />} />
        <Route path="/runs/new" element={<SubmitRun />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/criteria" element={<CriteriaList />} />
        <Route path="/criteria/new" element={<CreateCriterion />} />
        <Route path="/criteria/graph" element={<CriteriaGraphView />} />
        <Route path="/criteria/:id" element={<CriterionDetail />} />
        <Route path="/insights" element={<Insights />} />
      </Route>
    </Routes>
  );
}
