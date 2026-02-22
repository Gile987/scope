// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { RunsList } from "@/pages/RunsList";
import { RunDetail } from "@/pages/RunDetail";
import { SubmitRun } from "@/pages/SubmitRun";
import { CriteriaList } from "@/pages/CriteriaList";
import { CriterionDetail } from "@/pages/CriterionDetail";
import { CreateCriterion } from "@/pages/CreateCriterion";
import { CriteriaGraphView } from "@/pages/CriteriaGraphView";
import { Statistics } from "@/pages/Statistics";
import { PromptFeatureList } from "@/pages/PromptFeatureList";
import { PromptFeatureDetail } from "@/pages/PromptFeatureDetail";
import { CreatePromptFeature } from "@/pages/CreatePromptFeature";
import { PromptFeatureGraphView } from "@/pages/PromptFeatureGraphView";
import { ReportsList } from "@/pages/ReportsList";
import { ReportDetail } from "@/pages/ReportDetail";
import { TokenList } from "@/pages/TokenList";
import { CreateToken } from "@/pages/CreateToken";
import { TokenDetail } from "@/pages/TokenDetail";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/statistics" replace />} />
        <Route path="/runs" element={<RunsList />} />
        <Route path="/runs/new" element={<SubmitRun />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/reports" element={<ReportsList />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        <Route path="/criteria" element={<CriteriaList />} />
        <Route path="/criteria/new" element={<CreateCriterion />} />
        <Route path="/criteria/graph" element={<CriteriaGraphView />} />
        <Route path="/criteria/:id" element={<CriterionDetail />} />
        <Route path="/prompt-features" element={<PromptFeatureList />} />
        <Route path="/prompt-features/new" element={<CreatePromptFeature />} />
        <Route path="/prompt-features/graph" element={<PromptFeatureGraphView />} />
        <Route path="/prompt-features/:id" element={<PromptFeatureDetail />} />
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/tokens" element={<TokenList />} />
        <Route path="/tokens/new" element={<CreateToken />} />
        <Route path="/tokens/:id" element={<TokenDetail />} />
        <Route path="/agents" element={<AgentList />} />
        <Route path="/agents/:id" element={<AgentDetail />} />
      </Route>
    </Routes>
  );
}
