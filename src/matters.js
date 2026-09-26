// 退出协同中的事项目录与各退出路径的办理规则。
// 同一事项在不同路径下的阻断性不同：是否阻断决定由路径规则给出，而非事项本身。

export const MATTER_KINDS = Object.freeze({
  announcement: '公告',
  creditor_claims: '债权申报',
  tax_clearance: '税费结清',
  employee_rights: '员工权益',
  litigation: '诉讼限制',
  licenses: '许可证处置',
  platform_accounts: '平台账户处置',
});

export const EXIT_PATHS = Object.freeze({
  simplified: '简易注销',
  ordinary: '普通清算',
  forced: '强制退出',
  suspension: '个体工商户停业',
});

// blocking: 该事项未结清时阻断退出决定；非阻断事项仍留痕并转后续处置（如欠费不免除、推送主管部门）。
const PATH_RULES = Object.freeze({
  simplified: {
    announcement_days: 20,
    matters: {
      announcement: { blocking: true },
      creditor_claims: { blocking: true },
      tax_clearance: { blocking: true },
      employee_rights: { blocking: true },
      litigation: { blocking: true },
      licenses: { blocking: false },
      platform_accounts: { blocking: false },
    },
  },
  ordinary: {
    announcement_days: 45,
    matters: {
      announcement: { blocking: true },
      creditor_claims: { blocking: true },
      tax_clearance: { blocking: true },
      employee_rights: { blocking: true },
      litigation: { blocking: true },
      licenses: { blocking: true },
      platform_accounts: { blocking: true },
    },
  },
  forced: {
    announcement_days: 30,
    matters: {
      announcement: { blocking: true },
      creditor_claims: { blocking: false },
      tax_clearance: { blocking: false },
      employee_rights: { blocking: false },
      litigation: { blocking: true },
      licenses: { blocking: false },
      platform_accounts: { blocking: false },
    },
  },
  suspension: {
    announcement_days: 0,
    matters: {
      tax_clearance: { blocking: false },
      employee_rights: { blocking: false },
      platform_accounts: { blocking: false },
    },
  },
});

export function pathRule(path) {
  const rule = PATH_RULES[path];
  if (!rule) throw new Error(`未知退出路径：${path}`);
  return rule;
}

// 按路径生成初始事项清单，全部处于待核验状态。
export function initialMatters(path) {
  const rule = pathRule(path);
  return Object.entries(rule.matters).map(([kind, opts]) => {
    const matter = {
      kind,
      label: MATTER_KINDS[kind],
      blocking: opts.blocking,
      status: 'pending',
      detail: '等待部门回执或企业补正',
      receipts: [],
    };
    if (kind === 'creditor_claims') matter.claims = [];
    return matter;
  });
}
