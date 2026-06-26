// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { RunsList } from "@/pages/RunsList";
import { RunDetail } from "@/pages/RunDetail";
import { SubmitRun } from "@/pages/SubmitRun";
import { CriteriaList } from "@/pages/CriteriaList";
import { CriterionDetail } from "@/pages/CriterionDetail";
import { CriterionPreviewPanel } from "@/pages/CriterionPreviewPanel";
import { CreateCriterion } from "@/pages/CreateCriterion";
import { CriteriaGraphView } from "@/pages/CriteriaGraphView";
import { Statistics } from "@/pages/Statistics";
import { PromptFeatureList } from "@/pages/PromptFeatureList";
import { PromptFeatureDetail } from "@/pages/PromptFeatureDetail";
import { CreatePromptFeature } from "@/pages/CreatePromptFeature";
import { ReportsList } from "@/pages/ReportsList";
import { ReportDetail } from "@/pages/ReportDetail";
import { ReportPreviewPanel } from "@/pages/ReportPreviewPanel";
import { ReportTemplateList } from "@/pages/ReportTemplateList";
import { ReportTemplateDetail } from "@/pages/ReportTemplateDetail";
import { CreateReportTemplate } from "@/pages/CreateReportTemplate";
import { TokenList } from "@/pages/TokenList";
import { CreateToken } from "@/pages/CreateToken";
import { TokenDetail } from "@/pages/TokenDetail";
import { TokenPreviewPanel } from "@/pages/TokenPreviewPanel";
import { AccountList } from "@/pages/AccountList";
import { CreateAccount } from "@/pages/CreateAccount";
import { AccountDetail } from "@/pages/AccountDetail";
import { AgentList } from "@/pages/AgentList";
import { AgentDetail } from "@/pages/AgentDetail";
import { McpServerList } from "@/pages/McpServerList";
import { CreateMcpServer } from "@/pages/CreateMcpServer";
import { McpServerDetail } from "@/pages/McpServerDetail";
import { McpServerPreviewPanel } from "@/pages/McpServerPreviewPanel";
import { SkillList } from "@/pages/SkillList";
import { SkillDetail } from "@/pages/SkillDetail";
import { ExtensionList } from "@/pages/ExtensionList";
import { ExtensionDetail } from "@/pages/ExtensionDetail";
import { ExtensionPreviewPanel } from "@/pages/ExtensionPreviewPanel";
import { ProfileList } from "@/pages/ProfileList";
import { ProfileDetail } from "@/pages/ProfileDetail";
import { ProfilePreviewPanel } from "@/pages/ProfilePreviewPanel";
import { CreateProfile } from "@/pages/CreateProfile";
import { NewProfileVersion } from "@/pages/NewProfileVersion";
import { InsightsList } from "@/pages/InsightsList";
import { InsightDetail } from "@/pages/InsightDetail";
import { InsightPreviewPanel } from "@/pages/InsightPreviewPanel";
import { CriteriaMdpView } from "@/pages/CriteriaMdpView";
import { ModelList } from "@/pages/ModelList";
import { ModelDetail } from "@/pages/ModelDetail";
import { TaskPromptList } from "@/pages/TaskPromptList";
import { TaskPromptDetail } from "@/pages/TaskPromptDetail";
import { TaskPromptPreviewPanel } from "@/pages/TaskPromptPreviewPanel";
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
        <Route path="/runs" element={<FeatureRoute featureKey="runs" permissions="scope/run:read"><RunsList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="runs" permissions="scope/run:read"><RunPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/runs/new" element={<FeatureRoute featureKey="submit-run" permissions="scope/run:write"><SubmitRun /></FeatureRoute>} />
        <Route path="/runs/:id/:tab?" element={<FeatureRoute featureKey="runs" permissions="scope/run:read"><RunDetail /></FeatureRoute>} />
        <Route path="/reports" element={<FeatureRoute featureKey="reports" permissions="scope/report:read"><ReportsList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="reports" permissions="scope/report:read"><ReportPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/reports/templates" element={<FeatureRoute featureKey="report-templates" permissions="scope/report-template:read"><ReportTemplateList /></FeatureRoute>} />
        <Route path="/reports/templates/new" element={<FeatureRoute featureKey="report-templates" permissions="scope/report-template:write"><CreateReportTemplate /></FeatureRoute>} />
        <Route path="/reports/templates/:id" element={<FeatureRoute featureKey="report-templates" permissions="scope/report-template:read"><ReportTemplateDetail /></FeatureRoute>} />
        <Route path="/reports/:id" element={<FeatureRoute featureKey="reports" permissions="scope/report:read"><ReportDetail /></FeatureRoute>} />
        {/* Redirect old /report-templates URLs */}
        <Route path="/report-templates" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/report-templates/:id" element={<Navigate to="/reports/templates" replace />} />
        <Route path="/insights" element={<FeatureRoute featureKey="insights" permissions="scope/insight:read"><InsightsList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="insights" permissions="scope/insight:read"><InsightPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/insights/:id" element={<FeatureRoute featureKey="insights" permissions="scope/insight:read"><InsightDetail /></FeatureRoute>} />
        <Route path="/criteria" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:read"><CriteriaList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:read"><CriterionPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/criteria/new" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:write"><CreateCriterion /></FeatureRoute>} />
        <Route path="/criteria/graph" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:read"><CriteriaGraphView /></FeatureRoute>} />
        <Route path="/criteria/mdp" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:read"><CriteriaMdpView /></FeatureRoute>} />
        <Route path="/criteria/:id" element={<FeatureRoute featureKey="criteria" permissions="scope/criteria:read"><CriterionDetail /></FeatureRoute>} />
        <Route path="/prompt-features" element={<FeatureRoute featureKey="prompt-features" permissions="scope/prompt-feature:read"><PromptFeatureList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="prompt-features" permissions="scope/prompt-feature:read"><PromptFeatureDetail /></FeatureRoute>} />
        </Route>
        <Route path="/prompt-features/new" element={<FeatureRoute featureKey="prompt-features" permissions="scope/prompt-feature:write"><CreatePromptFeature /></FeatureRoute>} />
        <Route path="/task-prompts" element={<FeatureRoute featureKey="task-prompts" permissions="scope/task-prompt:read"><TaskPromptList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="task-prompts" permissions="scope/task-prompt:read"><TaskPromptPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/task-prompts/:id" element={<FeatureRoute featureKey="task-prompts" permissions="scope/task-prompt:read"><TaskPromptDetail /></FeatureRoute>} />
        <Route path="/statistics" element={<FeatureRoute featureKey="statistics" permissions="scope/run:read"><Statistics /></FeatureRoute>} />
        <Route path="/secrets" element={<Navigate to="/secrets/keys" replace />} />
        <Route path="/secrets/keys" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><TokenList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><TokenPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/secrets/keys/new" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><CreateToken /></FeatureRoute>} />
        <Route path="/secrets/keys/:id" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><TokenDetail /></FeatureRoute>} />
        <Route path="/secrets/accounts" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><AccountList /></FeatureRoute>} />
        <Route path="/secrets/accounts/new" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><CreateAccount /></FeatureRoute>} />
        <Route path="/secrets/accounts/:id" element={<FeatureRoute featureKey="tokens" permissions="scope/user:admin"><AccountDetail /></FeatureRoute>} />
        <Route path="/agents" element={<FeatureRoute featureKey="agents" permissions="scope/agent:read"><AgentList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="agents" permissions="scope/agent:read"><AgentDetail /></FeatureRoute>} />
        </Route>
        <Route path="/models" element={<FeatureRoute featureKey="models" permissions="scope/model:read"><ModelList /></FeatureRoute>}>
          <Route path=":id" element={<FeatureRoute featureKey="models" permissions="scope/model:read"><ModelDetail /></FeatureRoute>} />
        </Route>
        <Route path="/mcp-servers" element={<FeatureRoute featureKey="mcp" permissions="scope/mcp-server:read"><McpServerList /></FeatureRoute>}>
          <Route path=":slug/preview" element={<FeatureRoute featureKey="mcp" permissions="scope/mcp-server:read"><McpServerPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/mcp-servers/new" element={<FeatureRoute featureKey="mcp" permissions="scope/mcp-server:write"><CreateMcpServer /></FeatureRoute>} />
        <Route path="/mcp-servers/:slug" element={<FeatureRoute featureKey="mcp" permissions="scope/mcp-server:read"><McpServerDetail /></FeatureRoute>} />
        <Route path="/skills" element={<FeatureRoute featureKey="skills" permissions="scope/skill:read"><SkillList /></FeatureRoute>} />
        <Route path="/skills/*" element={<FeatureRoute featureKey="skills" permissions="scope/skill:read"><SkillDetail /></FeatureRoute>} />
        <Route path="/extensions" element={<FeatureRoute featureKey="extensions" permissions="scope/extension:read"><ExtensionList /></FeatureRoute>}>
          <Route path=":id/preview" element={<FeatureRoute featureKey="extensions" permissions="scope/extension:read"><ExtensionPreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/extensions/:id" element={<FeatureRoute featureKey="extensions" permissions="scope/extension:read"><ExtensionDetail /></FeatureRoute>} />
        <Route path="/profiles" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:read"><ProfileList /></FeatureRoute>}>
          <Route path=":profileId/preview" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:read"><ProfilePreviewPanel /></FeatureRoute>} />
        </Route>
        <Route path="/profiles/new" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:write"><CreateProfile /></FeatureRoute>} />
        <Route path="/profiles/:profileId" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:read"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/v/:version" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:read"><ProfileDetail /></FeatureRoute>} />
        <Route path="/profiles/:profileId/new-version" element={<FeatureRoute featureKey="profiles" permissions="scope/profile:write"><NewProfileVersion /></FeatureRoute>} />
        <Route path="/admin" element={<FeatureRoute featureKey="admin" permissions="scope/user:admin"><Admin /></FeatureRoute>} />
      </Route>
    </Routes>
  );
}
