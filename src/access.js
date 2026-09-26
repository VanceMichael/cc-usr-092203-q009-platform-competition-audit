// 角色视图：同一份案件资料按访问角色投影，控制可见范围。
// 企业可见自身待办与公开历史，但看不到未公开举报；债权人仅见公告信息与受控申报渠道；
// 登记人员可见完整资料。

import { CLAIM_CHANNEL } from './exitCase.js';

// 企业视图：待办清单 + 公开历史，内部事件（如未公开举报、迟到回执复核）一律过滤。
export function enterpriseView(c) {
  const todos = c.matters
    .filter((m) => m.status !== 'cleared')
    .map((m) => ({
      matter: m.kind,
      label: m.label,
      status: m.status,
      action: m.status === 'blocked' ? `处理阻断：${m.detail}` : '等待部门回执或补充材料',
    }));
  return {
    case_id: c.case_id,
    subject: c.subject,
    path: c.path,
    path_label: c.path_label,
    status: c.status,
    announcement_days: c.announcement_days,
    matters: c.matters.map(({ receipts, ...m }) => ({ ...m, receipt_count: receipts.length })),
    todos,
    history: c.history.filter((e) => e.visibility !== 'internal'),
    decisions: c.decisions.map((d) => ({
      decision_id: d.decision_id,
      label: d.label,
      active: d.active,
      explanations: d.explanations,
    })),
    path_suggestion: c.path_suggestion ?? null,
  };
}

// 债权人视图：公告信息、受控申报渠道和自己的申报记录，看不到其他债权人与内部记录。
export function creditorView(c, creditor_ref) {
  const announcement = c.matters.find((m) => m.kind === 'announcement');
  const claimsMatter = c.matters.find((m) => m.kind === 'creditor_claims');
  return {
    subject_name: c.subject.name,
    path_label: c.path_label,
    status: c.status,
    announcement: announcement ? { status: announcement.status, period_days: c.announcement_days } : null,
    claim_channel: claimsMatter ? CLAIM_CHANNEL : null,
    own_claims: (claimsMatter?.claims ?? []).filter((x) => x.creditor_ref === creditor_ref),
  };
}

// 登记人员视图：完整案件资料，含内部事件与核查状态。
export function registrarView(c) {
  return c;
}

export function projectCase(c, actor) {
  if (actor?.role === 'registrar') return registrarView(c);
  if (actor?.role === 'enterprise') return enterpriseView(c);
  if (actor?.role === 'creditor') return creditorView(c, actor.creditor_ref);
  throw new Error('未知的访问角色');
}
