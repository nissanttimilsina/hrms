/**
 * Nepal payroll calculation — pure functions, no I/O, fully unit-tested.
 * Every intermediate figure is returned in `taxDetail` so a payslip can be
 * reproduced and audited from the stored rules, salary and attendance inputs.
 */
const r2 = (n) => Math.round(n * 100) / 100;
const rupee = (n) => Math.round(n);

/** Progressive tax on annual taxable income. Returns { tax, sst, bands[] }. */
export function annualTax(taxable, slabs, { waiveSst = false } = {}) {
  let prev = 0; let tax = 0; let sst = 0; const bands = [];
  for (const s of slabs) {
    const top = s.upTo ?? Infinity;
    const inBand = Math.max(0, Math.min(taxable, top) - prev);
    if (inBand > 0) {
      const amt = s.sst && waiveSst ? 0 : (inBand * s.rate) / 100;
      bands.push({ from: prev, to: s.upTo, rate: s.sst && waiveSst ? 0 : s.rate, taxable: r2(inBand), tax: r2(amt), sst: !!s.sst });
      if (s.sst) sst += amt; else tax += amt;
    }
    prev = top;
    if (taxable <= top) break;
  }
  return { tax: r2(tax + sst), sst: r2(sst), incomeTax: r2(tax), bands };
}

/**
 * Calculate one employee's payroll item for a period.
 * @param input.salary       { basic, components:[{code,amount}], ssfEnrolled, pfPercent, citMonthly, taxProfile }
 * @param input.components   tenant component definitions { code, name, kind, taxable, prorated }
 * @param input.att          { calendarDays, unpaidDays, overtimeMinutes }  (period inputs)
 * @param input.adjustments  [{ kind, description, amount, taxable }]
 * @param input.rules        rule set JSON
 * @param input.ytd          { taxable, tax } already paid this fiscal year (approved runs)
 * @param input.monthsRemaining  months left in FY including this one (1..12)
 * @param input.employee     { gender, maritalStatus, pan, bank }
 */
export function calculateItem({ salary, components, att, adjustments = [], rules, ytd = { taxable: 0, tax: 0 }, monthsRemaining = 12, employee }) {
  const anomalies = [];
  const payFactor = att.calendarDays > 0 ? Math.max(0, (att.calendarDays - att.unpaidDays) / att.calendarDays) : 0;
  const lines = [];
  const basic = r2(Number(salary.basic) * payFactor);
  lines.push({ code: 'BASIC', name: 'Basic salary', kind: 'EARNING', amount: basic, taxable: true });

  for (const c of salary.components ?? []) {
    const def = components.find((d) => d.code === c.code && d.isActive !== false);
    if (!def) { anomalies.push(`Unknown salary component ${c.code}`); continue; }
    const amount = r2(Number(c.amount) * (def.prorated ? payFactor : 1));
    if (amount) lines.push({ code: def.code, name: def.name, kind: def.kind, amount, taxable: def.taxable });
  }
  if (att.overtimeMinutes > 0 && att.workingDaysInPeriod > 0) {
    const hourly = Number(salary.basic) / (att.calendarDays * 8);
    const ot = r2((att.overtimeMinutes / 60) * hourly * (rules.overtimeMultiplier ?? 1.5));
    if (ot) lines.push({ code: 'OVERTIME', name: `Overtime (${(att.overtimeMinutes / 60).toFixed(1)} h)`, kind: 'EARNING', amount: ot, taxable: true });
  }
  for (const a of adjustments) lines.push({ code: 'ADJ', name: a.description, kind: a.kind, amount: r2(Number(a.amount)), taxable: a.taxable });

  const earnings = lines.filter((l) => l.kind === 'EARNING');
  const gross = r2(earnings.reduce((n, l) => n + l.amount, 0));
  const taxableEarnings = r2(earnings.filter((l) => l.taxable).reduce((n, l) => n + l.amount, 0));

  // Retirement contributions
  const ssfEmployee = salary.ssfEnrolled ? r2(basic * rules.ssf.employeePercent / 100) : 0;
  const ssfEmployer = salary.ssfEnrolled ? r2(basic * rules.ssf.employerPercent / 100) : 0;
  const pf = r2(basic * Number(salary.pfPercent ?? 0) / 100);
  const pfEmployer = pf; // matching employer PF contribution
  const cit = r2(Number(salary.citMonthly ?? 0));

  // Monthly taxable figure: employer contributions are part of remuneration, then retirement deduction applies.
  const assessableMonth = r2(taxableEarnings + ssfEmployer + pfEmployer);
  const retirementMonth = ssfEmployee + ssfEmployer + pf + pfEmployer + cit;
  const projectedAssessable = r2(ytd.assessable ?? ytd.taxable ?? 0) + assessableMonth * monthsRemaining;
  const projectedRetirement = r2((ytd.retirement ?? 0) + retirementMonth * monthsRemaining);
  const rd = rules.retirementDeduction;
  const retirementDeduction = r2(Math.min(projectedRetirement, rd.maxAmount, projectedAssessable * rd.maxFraction));
  const tp = salary.taxProfile ?? {};
  const insurance = Math.min(Number(tp.lifeInsurance ?? 0), rules.insurance.lifeMax) + Math.min(Number(tp.healthInsurance ?? 0), rules.insurance.healthMax);
  const annualTaxable = Math.max(0, r2(projectedAssessable - retirementDeduction - insurance));
  const schedule = employee.maritalStatus === 'MARRIED' && tp.coupleAssessment ? 'MARRIED' : 'SINGLE';
  const t = annualTax(annualTaxable, rules.slabs[schedule], { waiveSst: !!(rules.sstWaivedForSsf && salary.ssfEnrolled) });
  let annual = t.tax;
  let rebate = 0;
  if (employee.gender === 'FEMALE' && rules.femaleRebatePercent && tp.femaleRebate !== false) {
    rebate = r2(t.incomeTax * rules.femaleRebatePercent / 100); // rebate applies to income tax, not SST
    annual = r2(annual - rebate);
  }
  const monthTax = Math.max(0, rupee((annual - Number(ytd.tax ?? 0)) / monthsRemaining));

  const deductionLines = [
    ...(ssfEmployee ? [{ code: 'SSF', name: `SSF (${rules.ssf.employeePercent}%)`, kind: 'DEDUCTION', amount: ssfEmployee }] : []),
    ...(pf ? [{ code: 'PF', name: `Provident Fund (${salary.pfPercent}%)`, kind: 'DEDUCTION', amount: pf }] : []),
    ...(cit ? [{ code: 'CIT', name: 'Citizen Investment Trust', kind: 'DEDUCTION', amount: cit }] : []),
    ...(monthTax ? [{ code: 'TDS', name: 'Income tax (TDS)', kind: 'DEDUCTION', amount: monthTax }] : []),
  ];
  const allLines = [...lines, ...deductionLines];
  const deductions = r2(allLines.filter((l) => l.kind === 'DEDUCTION').reduce((n, l) => n + l.amount, 0));
  const net = r2(gross - deductions);

  if (!employee.pan) anomalies.push('Missing PAN');
  if (!employee.bank?.last4) anomalies.push('Missing bank account');
  if (net <= 0) anomalies.push('Net pay is zero or negative');
  if (payFactor < 1) anomalies.push(`Unpaid days: ${att.unpaidDays}`);

  return {
    lines: allLines, gross, deductions, tax: monthTax, ssfEmployee, ssfEmployer, net, anomalies,
    taxDetail: {
      payFactor: r2(payFactor), assessableMonth, retirementMonth: r2(retirementMonth), monthsRemaining, projectedAssessable: r2(projectedAssessable),
      projectedRetirement, retirementDeduction, insuranceDeduction: insurance, annualTaxable, schedule, bands: t.bands, annualTaxBeforeRebate: t.tax,
      femaleRebate: rebate, annualTax: annual, ytdTaxPaid: Number(ytd.tax ?? 0), monthTax, sstWaived: !!(rules.sstWaivedForSsf && salary.ssfEnrolled), pfEmployer,
    },
  };
}
