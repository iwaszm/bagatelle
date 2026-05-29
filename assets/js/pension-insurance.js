let myChart = null;
let wageChart = null;

const CHART_THEME = {
    ink: '#18212f',
    muted: '#667085',
    grid: 'rgba(24, 33, 47, 0.09)',
    gold: '#b98a35',
    blue: '#234e9c',
    redBrown: 'rgba(132, 63, 55, 0.78)',
    fillBlue: 'rgba(35, 78, 156, 0.10)',
    fillGold: 'rgba(185, 138, 53, 0.12)'
};

if (window.Chart) {
    Chart.defaults.color = CHART_THEME.muted;
    Chart.defaults.font.family = "IBM Plex Sans, Noto Serif SC, sans-serif";
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
}

// 国家统计局：城镇非私营单位就业人员年平均工资（全国，元/年）
// 来源口径用于宏观趋势参考；页面展示折算为月平均工资。
const NATIONAL_URBAN_NON_PRIVATE_WAGE = [
    { year: 2014, annual: 56360 },
    { year: 2015, annual: 62029 },
    { year: 2016, annual: 67569 },
    { year: 2017, annual: 74318 },
    { year: 2018, annual: 82461 },
    { year: 2019, annual: 90501 },
    { year: 2020, annual: 97379 },
    { year: 2021, annual: 106837 },
    { year: 2022, annual: 114029 },
    { year: 2023, annual: 120698 }
];

const PAYOUT_MONTHS_BY_AGE = {
    40: 233, 41: 230, 42: 226, 43: 223, 44: 220,
    45: 216, 46: 212, 47: 208, 48: 204, 49: 199,
    50: 195, 51: 190, 52: 185, 53: 180, 54: 175,
    55: 170, 56: 164, 57: 158, 58: 152, 59: 145,
    60: 139, 61: 132, 62: 125, 63: 117, 64: 109,
    65: 101, 66: 93, 67: 84, 68: 75, 69: 65,
    70: 56
};

// 钱相关数字：只保留整数
const formatNum = (num) => {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(num || 0));
};

const getPayoutMonths = (age) => {
    const roundedAge = Math.min(70, Math.max(40, Math.round(age || 60)));
    return PAYOUT_MONTHS_BY_AGE[roundedAge] || 139;
};

// 快捷选项联动
function updateDefaultWage() {
    const val = parseFloat(document.getElementById('regionSelect').value);
    document.getElementById('wagePay').value = val;
    if (val === 7000) {
        document.getElementById('wageRetire').value = 8000;
    } else {
        document.getElementById('wageRetire').value = Math.round(val * 1.15);
    }
    calculate();
}

// 核心计算逻辑
function calculate() {
    const wagePay = parseFloat(document.getElementById('wagePay').value) || 0;
    const wageRetire = parseFloat(document.getElementById('wageRetire').value) || 0;
    const index = parseFloat(document.getElementById('payIndex').value) || 0;
    const birthYear = parseInt(document.getElementById('birthYear').value) || 0;
    const startYear = parseInt(document.getElementById('startYear').value) || 0;
    const retirementAge = parseInt(document.getElementById('retirementAge').value) || 65;
    const retirementYear = birthYear + retirementAge;
    const months = getPayoutMonths(retirementAge);

    document.getElementById('payoutMonthsHint').innerText = `计发月数：${months}个月（退休年份约 ${retirementYear || '—'}）`;

    // 1. 缴费计算：从起缴年份到退休年份
    const years = Math.max(0, retirementYear - startYear);

    const monthlyPay = wagePay * index * 0.20;
    const poolPay = wagePay * index * 0.12;
    const personalPay = wagePay * index * 0.08;

    const totalPay = monthlyPay * 12 * years;
    const totalPersonal = personalPay * 12 * years;

    // 2. 养老金领取计算
    const basicPension = wageRetire * (1 + index) / 2 * years * 0.01;
    const personalPension = months > 0 ? totalPersonal / months : 0;

    const totalPensionMonthly = basicPension + personalPension;

    // 3. 投资回报核算
    const paybackYears = totalPensionMonthly > 0 ? (totalPay / (totalPensionMonthly * 12)) : 0;
    const roi10 = totalPay > 0 ? (((totalPensionMonthly * 12 * 10) - totalPay) / totalPay * 100) : 0;

    // 4. 更新 UI 数据
    document.getElementById('outYears').innerText = years;
    document.getElementById('outMonthlyPay').innerText = formatNum(monthlyPay);
    document.getElementById('outPoolPay').innerText = formatNum(poolPay);
    document.getElementById('outPersonalPay').innerText = formatNum(personalPay);
    document.getElementById('outTotalPay').innerText = formatNum(totalPay);
    document.getElementById('outTotalPersonal').innerText = formatNum(totalPersonal);

    document.getElementById('outMonthlyPension').innerText = formatNum(totalPensionMonthly);
    document.getElementById('outBasicPension').innerText = formatNum(basicPension);
    document.getElementById('outPersonalPension').innerText = formatNum(personalPension);

    document.getElementById('outPayback').innerText = paybackYears.toFixed(1);
    document.getElementById('outRoi10').innerText = roi10.toFixed(1);

    // 5. 绘制图表
    drawChart(totalPay, totalPensionMonthly * 12);
    drawWageTrendChart();
}

// 绘制折线图：退休后累计领取 vs 成本
function drawChart(cost, annualPension) {
    const ctx = document.getElementById('pensionChart').getContext('2d');

    const retirementAge = parseInt(document.getElementById('retirementAge').value) || 65;
    const birthYear = parseInt(document.getElementById('birthYear').value) || 1988;
    const retirementYear = birthYear + retirementAge;
    const yearsArr = Array.from({length: 30}, (_, i) => i + 1);
    const costData = Array.from({length: 30}, () => cost);
    const incomeData = yearsArr.map(y => y * annualPension);

    if (myChart) {
        myChart.destroy();
    }

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: yearsArr.map(y => `${retirementYear + y - 1} / ${retirementAge + y - 1}岁`),
            datasets: [
                {
                    label: '累计缴纳成本 (本金)',
                    data: costData,
                    borderColor: CHART_THEME.redBrown,
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false
                },
                {
                    label: '累计领取养老金总额',
                    data: incomeData,
                    borderColor: CHART_THEME.ink,
                    backgroundColor: CHART_THEME.fillBlue,
                    borderWidth: 3,
                    pointRadius: 2,
                    pointBackgroundColor: CHART_THEME.gold,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: CHART_THEME.muted, boxWidth: 10, boxHeight: 10 } },
                tooltip: {
                    callbacks: {
                        label: function(context) { return context.dataset.label + ': ¥ ' + formatNum(context.parsed.y); }
                    }
                }
            },
            scales: {
                x: { grid: { color: CHART_THEME.grid }, ticks: { color: CHART_THEME.muted, maxTicksLimit: 10 } },
                y: {
                    grid: { color: CHART_THEME.grid },
                    title: { display: true, text: '金额 (元)', color: CHART_THEME.muted },
                    ticks: { callback: function(value) { return value >= 10000 ? formatNum(value / 10000) + '万' : formatNum(value); } }
                }
            }
        }
    });
}

// 绘制全国平均工资历史走势与预测
function drawWageTrendChart() {
    const ctx = document.getElementById('wageChart').getContext('2d');
    const historical = NATIONAL_URBAN_NON_PRIVATE_WAGE;
    const first = historical[0].annual;
    const last = historical[historical.length - 1].annual;
    const cagr = Math.pow(last / first, 1 / (historical.length - 1)) - 1;

    const forecastYears = [2024, 2025, 2026, 2027, 2028];
    const labels = historical.map(d => String(d.year)).concat(forecastYears.map(String));
    const historyMonthly = historical.map(d => Math.round(d.annual / 12)).concat(forecastYears.map(() => null));
    const forecastMonthly = historical.map((d, index) => index === historical.length - 1 ? Math.round(d.annual / 12) : null)
        .concat(forecastYears.map((year, i) => Math.round(last * Math.pow(1 + cagr, i + 1) / 12)));

    if (wageChart) {
        wageChart.destroy();
    }

    wageChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: '全国月平均工资（官方历史）',
                    data: historyMonthly,
                    borderColor: CHART_THEME.blue,
                    backgroundColor: CHART_THEME.fillBlue,
                    borderWidth: 3,
                    pointBackgroundColor: '#fffaf0',
                    pointBorderColor: CHART_THEME.blue,
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    fill: true,
                    tension: 0.28
                },
                {
                    label: `预测（月均，近十年CAGR ${(cagr * 100).toFixed(1)}%）`,
                    data: forecastMonthly,
                    borderColor: CHART_THEME.gold,
                    borderWidth: 3,
                    borderDash: [6, 4],
                    pointBackgroundColor: '#fffaf0',
                    pointBorderColor: CHART_THEME.gold,
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    fill: false,
                    tension: 0.28
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: CHART_THEME.muted, boxWidth: 10, boxHeight: 10 } },
                tooltip: {
                    callbacks: {
                        label: function(context) { return context.dataset.label + ': ¥ ' + formatNum(context.parsed.y) + '/月'; }
                    }
                }
            },
            scales: {
                x: { grid: { color: CHART_THEME.grid }, ticks: { color: CHART_THEME.muted } },
                y: {
                    grid: { color: CHART_THEME.grid },
                    title: { display: true, text: '月平均工资 (元)', color: CHART_THEME.muted },
                    ticks: { callback: function(value) { return '¥' + formatNum(value); } }
                }
            }
        }
    });
}

// 初始化
window.addEventListener('DOMContentLoaded', calculate);
