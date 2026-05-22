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
import { ReportsList } from "@/pages/ReportsList";
import { ReportDetail } from "@/pages/ReportDetail";
import { ReportTemplateList } from "@/pages/ReportTemplateList";
import { ReportTemplateDetail } from "@/pages/ReportTemplateDetail";
import { CreateReportTemplate } from "@/pages/CreateReportTemplate";
import { TokenList } from "@/pages/TokenList";
import { CreateToken } from "@/pages/CreateToken";
import { TokenDetail } from "@/pages/TokenDetail";
import { AccountList } from "@/pages/AccountList";
import { CreateAccount } from "@/pages/CreateAccount";
import { AccountDetail } from "@/pages/AccountDetail";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { McpServerList } from "@/pages/McpServerList";
import { CreateMcpServer } from "@/pages/CreateMcpServer";
import { McpServerDetail } from "@/pages/McpServerDetail";
import { SkillList } from "@/pages/SkillList";
import { SkillDetail } from "@/pages/SkillDetail";
import { ExtensionList } from "@/pages/ExtensionList";
import { ExtensionDetail } from "@/pages/ExtensionDetail";
import { ProfileList } from "@/pages/ProfileList";
import { ProfileDetail } from "@/pages/ProfileDetail";
import { CreateProfile } from "@/pages/CreateProfile";
import { NewProfileVersion } from "@/pages/NewProfileVersion";
import { InsightsList } from "@/pages/InsightsList";
import { InsightDetail } from "@/pages/InsightDetail";
import { CriteriaMdpView } from "@/pages/CriteriaMdpView";
import { ModelList } from "@/pages/ModelList";
import { ModelDetail } from "@/pages/ModelDetail";
import { TaskPromptList } from "@/pages/TaskPromptList";
import { TaskPromptDetail } from "@/pages/TaskPromptDetail";
import { RunPreviewPanel } from "@/pages/RunPreviewPanel";
import { Admin } from "@/pages/Admin";
import { FeatureRoute } from "@/components/FeatureRoute";
import { useFavicon } from "@/hooks/useFavicon";

export function App() {
  useFavicon();

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/statistics" replace />} />
        <Route path="/runs" element={<RunsList />}>
          <Route path=":id/preview" element={<RunPreviewPanel />} />
        </Route>
        <Route path="/runs/new" element={<SubmitRun />} />
        <Route path="/runs/:id/:tab?" element={<RunDetail />} />
        <Route path="/reports" element={<ReportsList />} />
        <Route path="/reports/templates" element={<ReportTemplateList />} />
        <Route path="/reports/templates/new" element={<CreateReportTemplate />} />
        <Route path="/reports/templates/:id" element={<ReportTemplateDetail />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        {/* Redirect old /report-templates URLs */}
        <Route path="/report-templates" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/report-templates/:id" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/insights" element={<InsightsList />} />
        <Route path="/insights/:id" element={<InsightDetail />} />
        <Route path="/criteria" element={<CriteriaList />} />
        <Route path="/criteria/new" element={<CreateCriterion />} />
        <Route path="/criteria/graph" element={<CriteriaGraphView />} />
        <Route path="/criteria/mdp" element={<CriteriaMdpView />} />
        <Route path="/criteria/:id" element={<CriterionDetail />} />
        <Route path="/prompt-features" element={<PromptFeatureList />}>
          <Route path=":id" element={<PromptFeatureDetail />} />
        </Route>
        <Route path="/prompt-features/new" element={<CreatePromptFeature />} />
        <Route path="/task-prompts" element={<TaskPromptList />} />
        <Route path="/task-prompts/:id" element={<TaskPromptDetail />} />
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/secrets" element={<Navigate to="/secrets/keys" replace />} />
        <Route path="/secrets/keys" element={<FeatureRoute featureKey="tokens"><TokenList /></FeatureRoute>} />
        <Route path="/secrets/keys/new" element={<FeatureRoute featureKey="tokens"><CreateToken /></FeatureRoute>} />
        <Route path="/secrets/keys/:id" element={<FeatureRoute featureKey="tokens"><TokenDetail /></FeatureRoute>} />
        <Route path="/secrets/accounts" element={<FeatureRoute featureKey="tokens"><AccountList /></FeatureRoute>} />
        <Route path="/secrets/accounts/new" element={<FeatureRoute featureKey="tokens"><CreateAccount /></FeatureRoute>} />
        <Route path="/secrets/accounts/:id" element={<FeatureRoute featureKey="tokens"><AccountDetail /></FeatureRoute>} />
        <Route path="/agents" element={<FeatureRoute featureKey="agents"><AgentList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="agents"><AgentDetail /></FeatureRoute>} />
        </Route>
        <Route path="/models" element={<FeatureRoute featureKey="models"><ModelList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="models"><ModelDetail /></FeatureRoute>} />
        </Route>
        <Route path="/mcp-servers" element={<FeatureRoute featureKey="mcp"><McpServerList /></FeatureRoute>} />
        <Route path="/mcp-servers/new" element={<FeatureRoute featureKey="mcp"><CreateMcpServer /></FeatureRoute>} />
        <Route path="/mcp-servers/:slug" element={<FeatureRoute featureKey="mcp"><McpServerDetail /></FeatureRoute>} />
        <Route path="/skills" element={<FeatureRoute featureKey="skills"><SkillList /></FeatureRoute>} />
        <Route path="/skills/*" element={<FeatureRoute featureKey="skills"><SkillDetail /></FeatureRoute>} />
        <Route path="/extensions" element={<FeatureRoute featureKey="extensions"><ExtensionList /></FeatureRoute>} />
        <Route path="/extensions/:id" element={<FeatureRoute featureKey="extensions"><ExtensionDetail /></FeatureRoute>} />
        <Route path="/profiles" element={<FeatureRoute featureKey="profiles"><ProfileList /></FeatureRoute>} />
        <Route path="/profiles/new" element={<FeatureRoute featureKey="profiles"><CreateProfile /></FeatureRoute>} />
        <Route path="/profiles/:profileId" element={<FeatureRoute featureKey="profiles"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/v/:version" element={<FeatureRoute featureKey="profiles"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/new-version" element={<FeatureRoute featureKey="profiles"><NewProfileVersion /></FeatureRoute>} />
        <Route path="/admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}
