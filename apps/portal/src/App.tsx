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
import { ReportTemplateList } from "@/pages/ReportTemplateList";
import { ReportTemplateDetail } from "@/pages/ReportTemplateDetail";
import { CreateReportTemplate } from "@/pages/CreateReportTemplate";
import { TokenList } from "@/pages/TokenList";
import { CreateToken } from "@/pages/CreateToken";
import { TokenDetail } from "@/pages/TokenDetail";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { McpServerList } from "@/pages/McpServerList";
import { CreateMcpServer } from "@/pages/CreateMcpServer";
import { McpServerDetail } from "@/pages/McpServerDetail";
import { SkillList } from "@/pages/SkillList";
import { InsightsList } from "@/pages/InsightsList";
import { InsightDetail } from "@/pages/InsightDetail";
import { ModelList } from "@/pages/ModelList";
import { ModelDetail } from "@/pages/ModelDetail";
import { TaskPromptList } from "@/pages/TaskPromptList";
import { TaskPromptDetail } from "@/pages/TaskPromptDetail";
import { Admin } from "@/pages/Admin";
import { FeatureRoute } from "@/components/FeatureRoute";

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
        <Route path="/report-templates" element={<ReportTemplateList />} />
        <Route path="/report-templates/new" element={<CreateReportTemplate />} />
        <Route path="/report-templates/:id" element={<ReportTemplateDetail />} />
        <Route path="/insights" element={<InsightsList />} />
        <Route path="/insights/:id" element={<InsightDetail />} />
        <Route path="/criteria" element={<CriteriaList />} />
        <Route path="/criteria/new" element={<CreateCriterion />} />
        <Route path="/criteria/graph" element={<CriteriaGraphView />} />
        <Route path="/criteria/:id" element={<CriterionDetail />} />
        <Route path="/prompt-features" element={<PromptFeatureList />} />
        <Route path="/prompt-features/new" element={<CreatePromptFeature />} />
        <Route path="/prompt-features/graph" element={<PromptFeatureGraphView />} />
        <Route path="/prompt-features/:id" element={<PromptFeatureDetail />} />
        <Route path="/task-prompts" element={<TaskPromptList />} />
        <Route path="/task-prompts/:id" element={<TaskPromptDetail />} />
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/tokens" element={<FeatureRoute featureKey="tokens"><TokenList /></FeatureRoute>} />
        <Route path="/tokens/new" element={<FeatureRoute featureKey="tokens"><CreateToken /></FeatureRoute>} />
        <Route path="/tokens/:id" element={<FeatureRoute featureKey="tokens"><TokenDetail /></FeatureRoute>} />
        <Route path="/agents" element={<FeatureRoute featureKey="agents"><AgentList /></FeatureRoute>} />
        <Route path="/agents/:id" element={<FeatureRoute featureKey="agents"><AgentDetail /></FeatureRoute>} />
        <Route path="/models" element={<FeatureRoute featureKey="models"><ModelList /></FeatureRoute>} />
        <Route path="/models/:id" element={<FeatureRoute featureKey="models"><ModelDetail /></FeatureRoute>} />
        <Route path="/mcp-servers" element={<FeatureRoute featureKey="mcp"><McpServerList /></FeatureRoute>} />
        <Route path="/mcp-servers/new" element={<FeatureRoute featureKey="mcp"><CreateMcpServer /></FeatureRoute>} />
        <Route path="/mcp-servers/:slug" element={<FeatureRoute featureKey="mcp"><McpServerDetail /></FeatureRoute>} />
        <Route path="/skills" element={<FeatureRoute featureKey="skills"><SkillList /></FeatureRoute>} />
        <Route path="/admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}
