import { HttpException } from '@nestjs/common';
import type {
  ConnectorAuth,
  PluginManifest,
  PluginTestResult,
  WorkflowNode,
} from '@maris/contracts';
import { buildRequest, RequestBuildError } from '../connectors/connector-request';
import { checkInputs } from '../ai/skills.service';
import { simulate } from '../workflows/workflow-engine';

function reason(e: unknown): string {
  if (e instanceof RequestBuildError) return e.message;
  if (e instanceof HttpException) {
    const r = e.getResponse() as { message?: string };
    return r.message ?? e.message;
  }
  return (e as Error).message;
}

/**
 * Runs a plugin's test suite without spending or calling anything: skill tests check their inputs
 * against the skill's fields; connector tests build the request (no network); workflow tests walk
 * the steps with placeholders where an AI would answer, and must finish within the plugin's budget.
 */
export function runPluginTests(m: PluginManifest): PluginTestResult[] {
  const { skills, connectors, workflows } = m.contents;
  return m.tests.map((t) => {
    const result = (ok: boolean, detail: string): PluginTestResult => ({
      name: t.name,
      kind: t.kind,
      key: t.key,
      ok,
      detail,
    });
    try {
      if (t.kind === 'skill') {
        const s = skills.find((x) => x.key === t.key);
        if (!s) return result(false, `Không có Skill "${t.key}"`);
        checkInputs(s.inputs, t.inputs);
        return result(true, 'Ô nhập hợp lệ');
      }
      if (t.kind === 'connector') {
        const c = connectors.find((x) => x.key === t.key);
        if (!c) return result(false, `Không có Connector "${t.key}"`);
        const cap = c.capabilities.find((x) => x.key === t.capability);
        if (!cap) return result(false, `Connector "${t.key}" không có thao tác "${t.capability}"`);
        if (!c.baseUrl) return result(false, 'Connector chưa có địa chỉ gọi');
        const r = buildRequest(
          { baseUrl: c.baseUrl, auth: c.auth as ConnectorAuth, headers: c.headers },
          cap,
          checkInputs(cap.inputs, t.inputs),
          c.auth.type === 'none' ? null : 'x-secret-placeholder',
        );
        return result(true, `Tạo được yêu cầu: ${r.summary}`);
      }
      const w = workflows.find((x) => x.key === t.key);
      if (!w) return result(false, `Không có Workflow "${t.key}"`);
      const trigger = w.graph.nodes[0] as Extract<WorkflowNode, { type: 'trigger' }>;
      const sim = simulate(
        w.graph,
        checkInputs(trigger.inputs, t.inputs),
        (key) => skills.find((s) => s.key === key)?.budgetUsd ?? 0,
      );
      if (sim.outcome !== 'completed')
        return result(false, `Dừng ở giới hạn ${w.graph.maxSteps} bước, chưa tới bước cuối`);
      if (sim.maxBudgetUsd > m.resources.maxRunUsd + 1e-9)
        return result(
          false,
          `Có thể tốn tới $${sim.maxBudgetUsd.toFixed(4)}, vượt ngân sách Plugin $${m.resources.maxRunUsd}`,
        );
      return result(
        true,
        `Chạy thử ${sim.steps.length} bước, ${sim.aiSteps} bước AI, tối đa $${sim.maxBudgetUsd.toFixed(4)}`,
      );
    } catch (e) {
      return result(false, reason(e));
    }
  });
}
