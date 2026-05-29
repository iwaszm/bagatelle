const EUR = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const fmt = (n) => EUR.format(Math.round(n || 0));

const TAX = {
    allowance: 12348,
    soliFree: 18130,
    pensionCap: 101400,
    healthCap: 69750,
    workExpenseAllowance: 1230,
    specialExpenseAllowance: 36,
    otherInsuranceDeductionCap: 1900,
    pensionRate: 0.093,      // RV 9.3%
    unemploymentRate: 0.013, // AV 1.3%
    healthRate: 0.08525,     // KV 8.525%
    careRate: 0.024          // PV 2.4%
};

function parseLocaleNumber(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return 0;
    const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(normalized) || 0;
}

const readNum = (id) => parseLocaleNumber(document.getElementById(id)?.value);
const readRate = (id) => parseFloat(String(document.getElementById(id)?.value || '').replace(',', '.')) || 0;

function formatMoneyInput(input) {
    if (!input) return;
    const value = parseLocaleNumber(input.value);
    input.value = value ? fmt(value) : '';
}

function handleMoneyInput(input) {
    if (!input) return;
    const value = parseLocaleNumber(input.value);
    input.value = value ? fmt(value) : '';
}

function togglePartner() {
    const joint = document.getElementById('filingMode').value === 'joint';
    const partner = document.getElementById('partnerSection');
    partner.classList.toggle('partner-disabled', !joint);
    partner.querySelectorAll('input, select').forEach(el => { el.disabled = !joint; });
}

function toggleSocialInputs() {
    const custom = document.getElementById('customSocialToggle')?.checked || false;
    const grid = document.getElementById('socialRateGrid');
    if (grid) grid.classList.toggle('social-rate-disabled', !custom);
    ['rateHealth', 'rateCare', 'ratePension', 'rateUnemployment'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.disabled = !custom;
    });
}

function getSocialRates() {
    const custom = document.getElementById('customSocialToggle')?.checked || false;
    if (!custom) {
        return {
            pensionRate: TAX.pensionRate,
            unemploymentRate: TAX.unemploymentRate,
            healthRate: TAX.healthRate,
            careRate: TAX.careRate
        };
    }
    return {
        pensionRate: (readRate('ratePension') || TAX.pensionRate * 100) / 100,
        unemploymentRate: (readRate('rateUnemployment') || TAX.unemploymentRate * 100) / 100,
        healthRate: (readRate('rateHealth') || TAX.healthRate * 100) / 100,
        careRate: (readRate('rateCare') || TAX.careRate * 100) / 100
    };
}

function germanIncomeTax2026(x) {
    const taxable = Math.max(0, x);
    if (taxable <= 12348) return 0;
    if (taxable <= 17799) {
        const y = (taxable - 12348) / 10000;
        return (914.51 * y + 1400) * y;
    }
    if (taxable <= 69878) {
        const z = (taxable - 17799) / 10000;
        return (173.1 * z + 2397) * z + 1034.87;
    }
    if (taxable <= 277825) return 0.42 * taxable - 11135.63;
    return 0.45 * taxable - 19470.38;
}

const germanIncomeTax2025 = germanIncomeTax2026;

function socialContrib(gross, rates = getSocialRates()) {
    const pensionBase = Math.min(gross, TAX.pensionCap);
    const healthBase = Math.min(gross, TAX.healthCap);
    const pension = pensionBase * rates.pensionRate;
    const unemployment = pensionBase * rates.unemploymentRate;
    const health = healthBase * rates.healthRate;
    const care = healthBase * rates.careRate;
    return { pension, unemployment, health, care, total: pension + unemployment + health + care };
}

function deductibleVorsorgepauschale(social, taxClass = 'I') {
    const deductibleHealth = social.health * 0.96; // 4% Krankengeld-Anteil nicht abziehbar
    const deductibleCare = social.care;
    const healthCareDeductible = deductibleHealth + deductibleCare;
    const deductibleUnemployment = taxClass === 'VI'
        ? 0
        : Math.min(
            social.unemployment,
            Math.max(0, TAX.otherInsuranceDeductionCap - healthCareDeductible)
        );
    return {
        pension: social.pension,
        health: deductibleHealth,
        care: deductibleCare,
        unemployment: deductibleUnemployment,
        total: social.pension + deductibleHealth + deductibleCare + deductibleUnemployment
    };
}

function estimateWithholding(taxable, taxClass, isJointLike) {
    let wageTax;
    switch (taxClass) {
        case 'II':
            wageTax = germanIncomeTax2026(Math.max(0, taxable - 4260));
            break;
        case 'III':
            wageTax = 2 * germanIncomeTax2026(taxable / 2);
            break;
        case 'V':
        case 'VI':
            wageTax = 2 * (germanIncomeTax2026(taxable * 1.25) - germanIncomeTax2026(taxable * 0.75));
            wageTax = applyClassFiveSixLimits(wageTax, taxable);
            break;
        case 'IV':
        case 'I':
        default:
            wageTax = germanIncomeTax2026(taxable);
    }
    return Math.max(0, wageTax);
}

function applyClassFiveSixLimits(rawTax, taxable) {
    const z = Math.max(0, taxable);
    const minimumTax = z * 0.14;
    const maximumTax = Math.min(z, 14071) * 0.14
        + Math.max(0, Math.min(z, 222260) - 14071) * 0.42
        + Math.max(0, z - 222260) * 0.45;
    return Math.min(Math.max(rawTax, minimumTax), maximumTax);
}

function soli(incomeTax, joint) {
    const threshold = TAX.soliFree * (joint ? 2 : 1);
    if (incomeTax <= threshold) return 0;
    // 简化：超过免征线后估算 5.5%，未模拟完整 Milderungszone。
    return incomeTax * 0.055;
}

function getPerson(prefix, active) {
    if (!active) return null;
    const gross = readNum(`gross${prefix}`) + readNum(`bonus${prefix}`);
    const taxClass = document.getElementById(`taxClass${prefix}`).value;
    const workExpenses = readNum(`workExpenses${prefix}`);
    return { prefix, name: `Person ${prefix}`, gross, taxClass, workExpenses };
}

function calculateTaxDashboard() {
    const joint = document.getElementById('filingMode').value === 'joint';
    const churchRate = 0;

    const people = [getPerson('A', true), getPerson('B', joint)].filter(Boolean);
    const socialRates = getSocialRates();
    const enriched = people.map(p => {
        const social = socialContrib(p.gross, socialRates);
        const deductibleSocial = deductibleVorsorgepauschale(social, p.taxClass);
        const workExpenseDeduction = Math.max(TAX.workExpenseAllowance, p.workExpenses || 0);
        const taxable = Math.max(0, p.gross - deductibleSocial.total - workExpenseDeduction - TAX.specialExpenseAllowance);
        const defaultTaxable = Math.max(0, p.gross - deductibleSocial.total - TAX.workExpenseAllowance - TAX.specialExpenseAllowance);
        const withholdingBase = p.taxClass === 'VI'
            ? Math.max(0, p.gross - deductibleSocial.total)
            : taxable;
        const lohnsteuerBase = p.taxClass === 'VI'
            ? Math.max(0, p.gross - deductibleSocial.total)
            : defaultTaxable;
        const estimatedWithheld = estimateWithholding(lohnsteuerBase, p.taxClass, joint);
        return { ...p, social, deductibleSocial, workExpenseDeduction, taxable, defaultTaxable, withholdingBase, lohnsteuerBase, estimatedWithheld };
    });

    const grossTotal = enriched.reduce((s, p) => s + p.gross, 0);
    const socialTotal = enriched.reduce((s, p) => s + p.social.total, 0);
    const taxableTotal = enriched.reduce((s, p) => s + p.taxable, 0);
    const defaultTaxableTotal = enriched.reduce((s, p) => s + p.defaultTaxable, 0);
    const withholdingBaseTotal = enriched.reduce((s, p) => s + p.withholdingBase, 0);
    const incomeTax = joint ? 2 * germanIncomeTax2026(taxableTotal / 2) : germanIncomeTax2026(taxableTotal);
    const defaultIncomeTax = joint ? 2 * germanIncomeTax2026(defaultTaxableTotal / 2) : germanIncomeTax2026(defaultTaxableTotal);
    const soliTax = soli(incomeTax, joint);
    const defaultSoliTax = soli(defaultIncomeTax, joint);
    const churchTax = incomeTax * churchRate;
    const defaultChurchTax = defaultIncomeTax * churchRate;
    const totalTax = incomeTax + soliTax + churchTax;
    const defaultTotalTax = defaultIncomeTax + defaultSoliTax + defaultChurchTax;
    const withheld = enriched.reduce((s, p) => s + p.estimatedWithheld, 0);
    const balance = totalTax - withheld;
    const payrollNet = grossTotal - socialTotal - withheld; // Sankey 展示工资单口径：先扣社保，再按税级扣工资税
    const assessedNet = grossTotal - socialTotal - defaultTotalTax; // Netto KPI: always default Werbungskostenpauschale

    document.getElementById('kpiGross').innerText = fmt(grossTotal);
    document.getElementById('kpiNetMonthly').innerText = fmt(assessedNet / 12);
    document.getElementById('kpiNetAnnual').innerText = fmt(assessedNet);
    document.getElementById('kpiSocial').innerText = fmt(socialTotal);
    document.getElementById('kpiTax').innerText = fmt(totalTax);
    document.getElementById('kpiWithheld').innerText = fmt(withheld);
    document.getElementById('kpiBalance').innerText = fmt(Math.abs(balance));
    document.getElementById('kpiBalanceWrap').className = balance > 0 ? 'text-2xl font-bold text-red-500' : 'text-2xl font-bold text-green-600';
    document.getElementById('kpiBalanceWrap').firstChild.textContent = balance > 0 ? '补税 € ' : '退税 € ';

    const socialItems = {
        pension: enriched.reduce((s, p) => s + p.social.pension, 0),
        unemployment: enriched.reduce((s, p) => s + p.social.unemployment, 0),
        health: enriched.reduce((s, p) => s + p.social.health, 0),
        care: enriched.reduce((s, p) => s + p.social.care, 0)
    };

    renderSankey({ joint, people: enriched, grossTotal, socialTotal, taxableTotal, socialItems, incomeTax, soliTax, churchTax, totalTax, payrollNet, assessedNet, balance, withheld });
    renderZveFormulaPanel({ people: enriched, withholdingBaseTotal, taxableTotal, joint });
    renderTaxRatePlot(withholdingBaseTotal, joint);
}

let taxSankeyChart = null;
let taxRateChart = null;

function renderSankey(data) {
    const el = document.getElementById('taxSankey');
    if (!window.echarts || !el) return;
    if (!taxSankeyChart) {
        taxSankeyChart = echarts.init(el, null, { renderer: 'svg' });
        window.addEventListener('resize', () => taxSankeyChart && taxSankeyChart.resize());
    }

    const grossLabel = '税前总收入/Gesamt-Brutto';
    const socialLabel = '社保/SV';
    const afterSocialLabel = '社保后收入';
    const wageTaxLabel = '工资税/Lohnsteuer';
    const netLabel = '税后年收入/Netto';
    const afterSocial = Math.max(0, data.grossTotal - data.socialTotal);
    const pct = (value) => data.grossTotal > 0 ? `${(value / data.grossTotal * 100).toFixed(1)}%` : '0.0%';
    const balanceLabel = data.balance > 0 ? '预计补税' : '预计退税';
    const balanceColor = data.balance > 0 ? '#843f37' : '#2f8f67';

    let nodeValues = {
        [grossLabel]: data.grossTotal,
        [socialLabel]: data.socialTotal,
        [afterSocialLabel]: afterSocial,
        'RV 养老': data.socialItems.pension,
        'KV 医保': data.socialItems.health,
        'PV 护理': data.socialItems.care,
        'AV 失业': data.socialItems.unemployment,
        [wageTaxLabel]: data.withheld,
        [netLabel]: data.payrollNet
    };

    let nodes = [
        { name: grossLabel, itemStyle: { color: '#18212f' }, depth: 0 },
        { name: socialLabel, itemStyle: { color: '#843f37' }, depth: 1 },
        { name: afterSocialLabel, itemStyle: { color: '#b98a35' }, depth: 1 },
        { name: 'RV 养老', itemStyle: { color: '#843f37' }, depth: 2 },
        { name: 'KV 医保', itemStyle: { color: '#9b6a35' }, depth: 2 },
        { name: 'PV 护理', itemStyle: { color: '#8b6f2a' }, depth: 2 },
        { name: 'AV 失业', itemStyle: { color: '#6f58b6' }, depth: 2 },
        { name: wageTaxLabel, itemStyle: { color: '#234e9c' }, depth: 2 },
        { name: netLabel, itemStyle: { color: '#2f8f67' }, depth: 2 }
    ];

    let links = [
        { source: grossLabel, target: socialLabel, value: data.socialTotal, lineStyle: { color: '#843f37' } },
        { source: grossLabel, target: afterSocialLabel, value: afterSocial, lineStyle: { color: '#b98a35' } },
        { source: socialLabel, target: 'RV 养老', value: data.socialItems.pension, lineStyle: { color: '#843f37' } },
        { source: socialLabel, target: 'KV 医保', value: data.socialItems.health, lineStyle: { color: '#9b6a35' } },
        { source: socialLabel, target: 'PV 护理', value: data.socialItems.care, lineStyle: { color: '#8b6f2a' } },
        { source: socialLabel, target: 'AV 失业', value: data.socialItems.unemployment, lineStyle: { color: '#6f58b6' } },
        { source: afterSocialLabel, target: wageTaxLabel, value: data.withheld, lineStyle: { color: '#234e9c' } },
        { source: afterSocialLabel, target: netLabel, value: data.payrollNet, lineStyle: { color: '#2f8f67' } }
    ].filter(link => link.value > 1);

    if (data.joint && data.people?.length > 1) {
        const personColors = {
            A: { gross: '#18212f', sv: '#843f37', after: '#b98a35', tax: '#234e9c', net: '#2f8f67' },
            B: { gross: '#2f3a4e', sv: '#a25145', after: '#d1a24b', tax: '#5475b8', net: '#4aa77c' }
        };
        nodeValues = { [grossLabel]: data.grossTotal };
        nodes = [{ name: grossLabel, itemStyle: { color: '#18212f' }, depth: 0 }];
        links = [];

        data.people.forEach((p, index) => {
            const colors = personColors[p.prefix] || personColors[index === 0 ? 'A' : 'B'];
            const personGross = `${p.name} Brutto`;
            const personSocial = `${p.name} 社保/SV`;
            const personAfterSocial = `${p.name} 社保后收入`;
            const personTax = `${p.name} 工资税/Lohnsteuer`;
            const personNet = `${p.name} 税后年收入/Netto`;
            const personAfterSocialValue = Math.max(0, p.gross - p.social.total);
            const personNetValue = Math.max(0, p.gross - p.social.total - p.estimatedWithheld);

            Object.assign(nodeValues, {
                [personGross]: p.gross,
                [personSocial]: p.social.total,
                [personAfterSocial]: personAfterSocialValue,
                [personTax]: p.estimatedWithheld,
                [personNet]: personNetValue
            });

            nodes.push(
                { name: personGross, itemStyle: { color: colors.gross }, depth: 1 },
                { name: personSocial, itemStyle: { color: colors.sv }, depth: 2 },
                { name: personAfterSocial, itemStyle: { color: colors.after }, depth: 2 },
                { name: personTax, itemStyle: { color: colors.tax }, depth: 3 },
                { name: personNet, itemStyle: { color: colors.net }, depth: 3 }
            );

            links.push(
                { source: grossLabel, target: personGross, value: p.gross, lineStyle: { color: colors.gross } },
                { source: personGross, target: personSocial, value: p.social.total, lineStyle: { color: colors.sv } },
                { source: personGross, target: personAfterSocial, value: personAfterSocialValue, lineStyle: { color: colors.after } },
                { source: personAfterSocial, target: personTax, value: p.estimatedWithheld, lineStyle: { color: colors.tax } },
                { source: personAfterSocial, target: personNet, value: personNetValue, lineStyle: { color: colors.net } }
            );
        });
        links = links.filter(link => link.value > 1);
    }

    taxSankeyChart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            confine: true,
            formatter: (params) => {
                if (params.dataType === 'edge') {
                    return `${params.data.source} → ${params.data.target}<br/><b>€ ${fmt(params.data.value)}</b><br/>占 Brutto：${pct(params.data.value)}`;
                }
                const value = nodeValues[params.name] || 0;
                return `${params.name}<br/><b>€ ${fmt(value)}</b><br/>占 Brutto：${pct(value)}`;
            }
        },
        series: [{
            type: 'sankey',
            left: 20,
            right: 260,
            top: 18,
            bottom: 20,
            nodeWidth: 24,
            nodeGap: 15,
            nodeAlign: 'justify',
            draggable: false,
            emphasis: { focus: 'adjacency' },
            data: nodes,
            links,
            label: {
                color: '#18212f',
                fontFamily: 'IBM Plex Sans, Noto Serif SC, sans-serif',
                fontSize: 11,
                fontWeight: 700,
                formatter: (params) => {
                    const value = nodeValues[params.name] || 0;
                    return `${params.name}\n€${fmt(value)} (${pct(value)})`;
                }
            },
            lineStyle: {
                color: 'source',
                opacity: 0.42,
                curveness: 0.5
            },
            itemStyle: {
                borderWidth: 0,
                borderRadius: 6
            }
        }]
    }, true);
}

function marginalTaxRate2026(x) {
    const taxable = Math.max(0, x);
    if (taxable <= 12348) return 0;
    if (taxable <= 17799) {
        const y = (taxable - 12348) / 10000;
        return (2 * 914.51 * y + 1400) / 10000;
    }
    if (taxable <= 69878) {
        const z = (taxable - 17799) / 10000;
        return (2 * 173.1 * z + 2397) / 10000;
    }
    if (taxable <= 277825) return 0.42;
    return 0.45;
}

function renderTaxRatePlot(currentTaxable = 0, joint = false) {
    const el = document.getElementById('taxRatePlot');
    if (!window.echarts || !el) return;
    if (!taxRateChart) {
        taxRateChart = echarts.init(el, null, { renderer: 'svg' });
        window.addEventListener('resize', () => taxRateChart && taxRateChart.resize());
    }

    const maxIncome = 320000;
    const step = 1000;
    const averagePoints = [];
    const marginalPoints = [];
    const taxForZvE = (zvE) => joint ? 2 * germanIncomeTax2026(zvE / 2) : germanIncomeTax2026(zvE);
    const marginalForZvE = (zvE) => joint ? marginalTaxRate2026(zvE / 2) : marginalTaxRate2026(zvE);
    for (let zvE = 0; zvE <= maxIncome; zvE += step) {
        const tax = taxForZvE(zvE);
        const averageRate = zvE > 0 ? tax / zvE * 100 : 0;
        const marginalRate = marginalForZvE(zvE) * 100;
        averagePoints.push([zvE, Number(averageRate.toFixed(3))]);
        marginalPoints.push([zvE, Number(marginalRate.toFixed(3))]);
    }

    const markerIncome = Math.max(0, Math.min(currentTaxable, maxIncome));
    const markerTax = taxForZvE(markerIncome);
    const markerRate = markerIncome > 0 ? markerTax / markerIncome * 100 : 0;
    const pctFmt = (value, digits = 1) => Number(value || 0).toLocaleString('de-DE', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });

    taxRateChart.setOption({
        backgroundColor: 'transparent',
        legend: {
            top: 0,
            right: 20,
            itemWidth: 18,
            itemHeight: 8,
            textStyle: { color: '#667085', fontWeight: 700 }
        },
        grid: { left: 58, right: 30, top: 58, bottom: 44 },
        graphic: [],
        tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (items) => {
                const point = items[0];
                const zvE = point.data[0];
                const tax = taxForZvE(zvE);
                const average = zvE > 0 ? tax / zvE * 100 : 0;
                const marginal = marginalForZvE(zvE) * 100;
                const mode = joint ? '夫妇合并：2 × ESt(zvE / 2)' : '个人：ESt(zvE)';
                return `${mode}<br/>应税收入/zvE：<b>€ ${fmt(zvE)}</b><br/>应税/ESt：<b>€ ${fmt(tax)}</b>（${pctFmt(average, 2)}%）<br/>边际税率：${pctFmt(marginal, 1)}%`;
            }
        },
        xAxis: {
            type: 'value',
            name: '应税收入/zvE',
            nameLocation: 'middle',
            nameGap: 30,
            min: 0,
            max: maxIncome,
            axisLabel: { formatter: (value) => `${Math.round(value / 1000)}k`, color: '#667085' },
            nameTextStyle: { color: '#18212f', fontWeight: 700 },
            splitLine: { lineStyle: { color: 'rgba(34,49,73,.08)' } }
        },
        yAxis: {
            type: 'value',
            name: '税率（%）',
            min: 0,
            max: 50,
            axisLabel: { formatter: '{value}%', color: '#667085' },
            nameTextStyle: { color: '#18212f', fontWeight: 700 },
            splitLine: { lineStyle: { color: 'rgba(34,49,73,.08)' } }
        },
        series: [{
            name: '平均税率',
            type: 'line',
            smooth: true,
            symbol: 'none',
            data: averagePoints,
            lineStyle: { width: 3, color: '#234e9c' },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(35,78,156,.22)' },
                    { offset: 1, color: 'rgba(185,138,53,.04)' }
                ])
            },
            markLine: {
                symbol: 'none',
                silent: true,
                lineStyle: { color: '#b98a35', type: 'dashed', width: 1.6 },
                label: {
                    show: true,
                    position: 'end',
                    distance: [0, -8],
                    formatter: `${joint ? '合并 ' : ''}zvE € ${fmt(markerIncome)} · 应税/ESt € ${fmt(markerTax)} (${pctFmt(markerRate, 1)}%)`,
                    color: '#18212f',
                    fontWeight: 800,
                    fontSize: 11,
                    backgroundColor: 'rgba(255,253,248,.72)',
                    borderColor: '#b98a35',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    padding: [4, 7]
                },
                data: markerIncome > 0 ? [{ xAxis: markerIncome }] : []
            },
        }, {
            name: '边际税率',
            type: 'line',
            step: 'end',
            symbol: 'none',
            data: marginalPoints,
            lineStyle: { width: 2.4, color: '#b84c3f' }
        }]
    }, true);
}

function renderZveFormulaPanel(data) {
    const el = document.getElementById('zveFormulaPanel');
    if (!el) return;

    const personRows = ['A', 'B'].map(prefix => {
        const p = data.people.find(person => person.prefix === prefix);
        if (!p) {
            return `
                <div class="zve-person-row zve-person-empty">
                    <div class="zve-row-head"><strong>Person ${prefix}</strong><span>未启用</span></div>
                </div>`;
        }
        const wk = p.taxClass === 'VI' ? 0 : Math.max(TAX.workExpenseAllowance, p.workExpenses || 0);
        const sa = p.taxClass === 'VI' ? 0 : TAX.specialExpenseAllowance;
        const rows = [
            { label: 'Brutto', value: p.gross, sign: '+' },
            { label: 'RV', value: -p.deductibleSocial.pension },
            { label: 'KV 96%', value: -p.deductibleSocial.health },
            { label: 'PV', value: -p.deductibleSocial.care },
            { label: p.taxClass === 'VI' ? 'AV（VI 不计）' : 'AV', value: -p.deductibleSocial.unemployment }
        ];
        if (p.taxClass !== 'VI') {
            rows.push(
                { label: 'Werbungskosten', value: -wk },
                { label: 'Sonderausgaben', value: -sa }
            );
        }
        const z = p.lohnsteuerBase;
        let lohnsteuerFormula = 'LSt = ESt(zvE)';
        let lohnsteuerDetails = `<div>ESt(zvE) = € ${fmt(germanIncomeTax2026(z))}</div>`;
        let lohnsteuerNote = '';
        if (p.taxClass === 'II') {
            const base = Math.max(0, z - 4260);
            lohnsteuerFormula = 'LSt = ESt(zvE - 4.260)';
            lohnsteuerDetails = `<div>ESt(zvE - 4.260) = € ${fmt(germanIncomeTax2026(base))}</div>`;
        } else if (p.taxClass === 'III') {
            const base = z / 2;
            const halfTax = germanIncomeTax2026(base);
            lohnsteuerFormula = 'LSt = 2 × ESt(zvE / 2)';
            lohnsteuerDetails = `<div>ESt(zvE / 2) = € ${fmt(halfTax)}</div><div>2 × ESt(zvE / 2) = € ${fmt(2 * halfTax)}</div>`;
        } else if (p.taxClass === 'V' || p.taxClass === 'VI') {
            const upperBase = z * 1.25;
            const lowerBase = z * 0.75;
            const upperTax = germanIncomeTax2026(upperBase);
            const lowerTax = germanIncomeTax2026(lowerBase);
            const rawTax = 2 * (upperTax - lowerTax);
            lohnsteuerFormula = 'LSt = 2 × [ESt(1,25zvE) - ESt(0,75zvE)]';
            lohnsteuerDetails = `<div>ESt(1,25zvE) = € ${fmt(upperTax)}</div><div>ESt(0,75zvE) = € ${fmt(lowerTax)}</div><div>Rohwert = € ${fmt(rawTax)}</div>`;
            lohnsteuerNote = 'final mit §39b 14% / 42% / 45% Grenze';
        }
        const calcRows = rows.map(row => `
            <div class="zve-calc-row ${row.value < 0 ? 'deduction' : 'income'}">
                <span>${row.label}</span>
                <b>${row.value < 0 ? '−' : '+'} € ${fmt(Math.abs(row.value))}</b>
            </div>`).join('');
        return `
            <div class="zve-person-row">
                <div class="zve-row-head"><strong>${p.name}</strong><span>税级 ${p.taxClass}</span></div>
                <div class="zve-stack">
                    <div class="zve-result-line"><span>zvE =</span><strong>€ ${fmt(p.withholdingBase)}</strong></div>
                    ${calcRows}
                    <div class="lohnsteuer-block">
                        <div class="zve-result-line lohnsteuer-result"><span>Lohnsteuer =</span><strong>€ ${fmt(p.estimatedWithheld)}</strong></div>
                        <div class="lohnsteuer-formula">${lohnsteuerFormula}</div>
                        <div class="lohnsteuer-details">${lohnsteuerDetails}</div>
                        ${lohnsteuerNote ? `<div class="lohnsteuer-note">${lohnsteuerNote}</div>` : ''}
                    </div>
                </div>
            </div>`;
    }).join('');

    el.innerHTML = `
        <div class="zve-person-grid">${personRows}</div>
    `;
}


window.addEventListener('DOMContentLoaded', () => {
    togglePartner();
    toggleSocialInputs();
    calculateTaxDashboard();
});
