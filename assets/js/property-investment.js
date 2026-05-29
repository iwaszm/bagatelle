// 核心常数假设
const BUYING_COST_RATE = 0.08; // 8% 购房附加费
const BUILDING_RATIO = 0.75; // 建筑价值占比(用于计算折旧)
const DEPRECIATION_RATE = 0.02; // 2% 直线折旧 AfA
const RENT_INCREASE_RATE = 0.01; // 每年租金涨幅 1.0%
const PROP_APPRECIATION_RATE = 0.01; // 每年房价涨幅 1.0%

let chartInstance = null;
let macroChartInstance = null; // 新增宏观图表实例变量

const CHART_THEME = {
    ink: '#18212f',
    muted: '#667085',
    grid: 'rgba(24, 33, 47, 0.09)',
    rent: 'rgba(185, 138, 53, 0.74)',
    tax: 'rgba(35, 78, 156, 0.72)',
    mortgage: 'rgba(132, 63, 55, 0.72)',
    wealth: '#18212f',
    forecast: '#6f58b6',
    fillBlue: 'rgba(35, 78, 156, 0.10)'
};

if (window.Chart) {
    Chart.defaults.color = CHART_THEME.muted;
    Chart.defaults.font.family = "IBM Plex Sans, Noto Serif SC, sans-serif";
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
}

// 格式化货币
const formatEuro = (num) => {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(num);
};

// UI选中状态高亮
const updateRadioStyle = () => {
    document.querySelectorAll('input[name="propertyOption"]').forEach(radio => {
        const label = radio.closest('label');
        if (radio.checked) {
            label.classList.add('bg-blue-50', 'border-blue-200');
        } else {
            label.classList.remove('bg-blue-50', 'border-blue-200');
        }
    });
};

// 选择自定义标的（输入框聚焦时自动切换）
const selectCustomProperty = () => {
    const customRadio = document.querySelector('input[name="propertyOption"][value="custom"]');
    if (customRadio && !customRadio.checked) {
        customRadio.checked = true;
    }
};

// 获取当前自定义房产数据
const getSelectedProperty = () => {
    const customPriceWan = Math.max(1, parseFloat(document.getElementById('customPriceInput').value) || 0);
    const customRent = Math.max(0, parseFloat(document.getElementById('customRentInput').value) || 0);
    return { price: customPriceWan * 10000, rent: customRent };
};

// 同步滑动条逻辑 (存款+贷款 = 房价总成本)
const syncLoanFromDeposit = () => {
    const prop = getSelectedProperty();
    const totalCost = prop.price * (1 + BUYING_COST_RATE);
    const deposit = parseFloat(document.getElementById('depositInput').value);
    let calculatedLoan = totalCost - deposit;
    if (calculatedLoan < 0) calculatedLoan = 0;
    document.getElementById('loanInput').value = calculatedLoan;
};

const syncDepositFromLoan = () => {
    const prop = getSelectedProperty();
    const totalCost = prop.price * (1 + BUYING_COST_RATE);
    const loan = parseFloat(document.getElementById('loanInput').value);
    let calculatedDeposit = totalCost - loan;
    if (calculatedDeposit < 0) calculatedDeposit = 0;
    document.getElementById('depositInput').value = calculatedDeposit;
};

// 主计算逻辑
const calculate = () => {
    updateRadioStyle();

    const prop = getSelectedProperty();
    const price = prop.price;
    const initialRent = prop.rent;
    
    const totalCost = price * (1 + BUYING_COST_RATE);
    document.getElementById('totalCostDisplay').innerText = formatEuro(totalCost);

    const deposit = parseFloat(document.getElementById('depositInput').value);
    let loan = parseFloat(document.getElementById('loanInput').value);
    
    if (Math.abs((deposit + loan) - totalCost) > 100) {
       loan = totalCost - deposit;
       document.getElementById('loanInput').value = loan;
    }

    const interestRate = parseFloat(document.getElementById('interestRateInput').value) / 100;
    const loanTerm = parseInt(document.getElementById('loanTermInput').value);
    const taxRate = parseFloat(document.getElementById('taxRateInput').value) / 100;

    // 更新UI标签
    document.getElementById('depositVal').innerText = formatEuro(deposit);
    document.getElementById('loanVal').innerText = formatEuro(loan);
    document.getElementById('interestRateVal').innerText = (interestRate * 100).toFixed(2) + '%';
    document.getElementById('loanTermVal').innerText = loanTerm + '年';
    document.getElementById('taxRateVal').innerText = (taxRate * 100).toFixed(0) + '%';

    // 等额本息 (PMT) 计算
    const monthlyInterestRate = interestRate / 12;
    const numPayments = loanTerm * 12;
    let monthlyMortgage = 0;
    
    if (interestRate > 0 && loan > 0) {
        monthlyMortgage = loan * (monthlyInterestRate * Math.pow(1 + monthlyInterestRate, numPayments)) / (Math.pow(1 + monthlyInterestRate, numPayments) - 1);
    } else if (loan > 0) {
        monthlyMortgage = loan / numPayments;
    }

    const totalPayment = monthlyMortgage * numPayments;
    const totalInterest = totalPayment - loan;
    const annualDepreciationAfA = price * BUILDING_RATIO * DEPRECIATION_RATE;

    let labels = [];
    let rentData = [];
    let mortgageData = [];
    let taxEffectData = [];
    let netCashflowLine = [];
    let netWealthLine = [];

    let currentLoan = loan;
    let currentRentYearly = initialRent * 12;
    let currentPropValue = price;
    let cumulativeCashflow = 0;
    
    let firstYearNetCashflow = 0;

    // 为了确保能看到“20年后净资产”，强制循环至少运行到第20年
    // 如果贷款年限超过20年，则运行到贷款结束
    let maxYears = Math.max(loanTerm, 20); 

    for (let year = 1; year <= maxYears; year++) {
        labels.push('第' + year + '年');

        let interestYear = 0;
        let actualAnnuityYear = 0; // 当年实际支付的月供（因为可能有提前还完的情况）

        // 如果当年还有欠款，逐月计算
        if (currentLoan > 0.01) {
            for(let m=0; m<12; m++) {
                if (currentLoan > 0.01) {
                    let interestMonth = currentLoan * monthlyInterestRate;
                    let principalMonth = monthlyMortgage - interestMonth;
                    
                    // 最后一个月的处理：避免多扣本金
                    if (currentLoan < principalMonth) {
                        principalMonth = currentLoan; 
                    }
                    
                    interestYear += interestMonth;
                    currentLoan -= principalMonth;
                    actualAnnuityYear += (interestMonth + principalMonth);
                }
            }
        }
        
        if(currentLoan < 0) currentLoan = 0;

        // 税务影响计算
        let taxableIncome = currentRentYearly - interestYear - annualDepreciationAfA;
        let taxEffect = -taxableIncome * taxRate;

        // 净现金流 (年)
        let netCashflowYear = currentRentYearly - actualAnnuityYear + taxEffect;
        cumulativeCashflow += netCashflowYear;

        if (year === 1) {
            firstYearNetCashflow = netCashflowYear / 12;
        }

        // 资产增值
        currentPropValue *= (1 + PROP_APPRECIATION_RATE);
        let netWealth = currentPropValue - currentLoan + cumulativeCashflow;

        // 填充图表
        rentData.push(currentRentYearly);
        mortgageData.push(-actualAnnuityYear); 
        taxEffectData.push(taxEffect);
        netCashflowLine.push(netCashflowYear);
        netWealthLine.push(netWealth);

        // 租金涨幅
        currentRentYearly *= (1 + RENT_INCREASE_RATE);
    }

    // 更新KPI面板
    document.getElementById('kpi-mortgage').innerText = formatEuro(monthlyMortgage);
    document.getElementById('kpi-total-interest').innerText = formatEuro(totalInterest);
    
    const netCashElement = document.getElementById('kpi-netcashflow');
    netCashElement.innerText = formatEuro(firstYearNetCashflow);
    if(firstYearNetCashflow < 0) {
        netCashElement.className = "text-2xl font-bold text-red-500";
    } else {
        netCashElement.className = "text-2xl font-bold text-green-600";
    }

    // 获取并显示第20年的净资产（索引为19）
    document.getElementById('kpi-netwealth').innerText = formatEuro(netWealthLine[19]);
    document.getElementById('chartTitle').innerText = `全生命周期收益曲线 (${maxYears}年模拟)`;

    renderChart(labels, rentData, mortgageData, taxEffectData, netWealthLine);
};

// 渲染图表
const renderChart = (labels, rent, mortgage, tax, wealth) => {
    const ctx = document.getElementById('financialChart').getContext('2d');
    
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: '年度租金收入',
                    data: rent,
                    backgroundColor: CHART_THEME.rent,
                    borderColor: 'rgba(185, 138, 53, 0.96)',
                    borderWidth: 1,
                    borderRadius: 6,
                    yAxisID: 'y'
                },
                {
                    label: '年度抵税额/交税额',
                    data: tax,
                    backgroundColor: CHART_THEME.tax,
                    borderColor: 'rgba(35, 78, 156, 0.94)',
                    borderWidth: 1,
                    borderRadius: 6,
                    yAxisID: 'y'
                },
                {
                    label: '年度支出总额 (月供/负向)',
                    data: mortgage,
                    backgroundColor: CHART_THEME.mortgage,
                    borderColor: 'rgba(132, 63, 55, 0.94)',
                    borderWidth: 1,
                    borderRadius: 6,
                    yAxisID: 'y'
                },
                {
                    label: '净资产累积 (右轴)',
                    data: wealth,
                    type: 'line',
                    borderColor: CHART_THEME.wealth,
                    borderWidth: 3,
                    pointBackgroundColor: '#fffaf0',
                    pointBorderColor: CHART_THEME.wealth,
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    fill: false,
                    tension: 0.4,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                },
                legend: {
                    position: 'bottom',
                    labels: { color: CHART_THEME.muted, boxWidth: 10, boxHeight: 10 }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { color: CHART_THEME.grid },
                    ticks: { color: CHART_THEME.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
                },
                y: {
                    stacked: true,
                    position: 'left',
                    grid: { color: CHART_THEME.grid },
                    title: {
                        display: true,
                        color: CHART_THEME.muted,
                        text: '现金流金额 (€)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value / 1000 + 'k €';
                        }
                    }
                },
                y1: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    title: {
                        display: true,
                        color: CHART_THEME.muted,
                        text: '净资产总值 (€)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value / 1000 + 'k €';
                        }
                    }
                }
            }
        }
    });
};

// 渲染宏观利率图表
const renderMacroChart = () => {
    const ctxMacro = document.getElementById('macroInterestChart').getContext('2d');
    
    // X轴时间节点
    const macroLabels = [
        '2020 H1', '2020 H2', '2021 H1', '2021 H2', 
        '2022 H1', '2022 H2', '2023 H1', '2023 H2', 
        '2024 H1', '2024 H2', '2025 H1', '2025 H2', 
        '2026 现在', '2026 H2', '2027 H1', '2027 H2', '2028'
    ];

    // 历史数据 (2020-2026当前)
    // 2020-2021: ~1% 极低利率
    // 2022: 从1.5%飙升至3.5%+
    // 2023: 峰值达到4.2%左右
    // 2024-2025: 在3.5%-4.0%震荡回落
    // 2026(现在): 约3.5%
    const historyData = [1.1, 1.0, 1.1, 1.2, 1.6, 3.4, 3.9, 4.2, 3.7, 3.5, 3.6, 3.4, 3.5, null, null, null, null];
    
    // 预测数据 (接续2026当前点，呈平缓下降趋势)
    const forecastData = [null, null, null, null, null, null, null, null, null, null, null, null, 3.5, 3.4, 3.3, 3.2, 3.1];

    macroChartInstance = new Chart(ctxMacro, {
        type: 'line',
        data: {
            labels: macroLabels,
            datasets: [
                {
                    label: '历史实际利率 (%)',
                    data: historyData,
                    borderColor: CHART_THEME.tax,
                    backgroundColor: CHART_THEME.fillBlue,
                    borderWidth: 3,
                    pointBackgroundColor: '#fffaf0',
                    pointBorderColor: CHART_THEME.tax,
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: '机构未来预测 (%)',
                    data: forecastData,
                    borderColor: '#b98a35',
                    borderWidth: 3,
                    borderDash: [6, 4], // 虚线表示预测
                    pointBackgroundColor: '#fffaf0',
                    pointBorderColor: '#b98a35',
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    pointStyle: 'rectRot',
                    fill: false,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                annotation: {
                    annotations: {
                        currentTimeline: {
                            type: 'line',
                            scaleID: 'x',
                            value: '2026 现在',
                            borderColor: 'rgba(185, 138, 53, 0.72)',
                            borderWidth: 2,
                            borderDash: [2, 2],
                            label: {
                                display: true,
                                content: '当前时刻',
                                position: 'start',
                                backgroundColor: 'rgba(24, 33, 47, 0.88)',
                                color: '#fffaf0',
                                font: { size: 11 }
                            }
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y + '%';
                        }
                    }
                },
                legend: {
                    position: 'top',
                    labels: { color: CHART_THEME.muted, boxWidth: 10, boxHeight: 10 }
                }
            },
            scales: {
                x: {
                    grid: { color: CHART_THEME.grid },
                    ticks: { color: CHART_THEME.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 9 }
                },
                y: {
                    beginAtZero: true,
                    max: 5.0,
                    grid: { color: CHART_THEME.grid },
                    title: {
                        display: true,
                        color: CHART_THEME.muted,
                        text: '10年期固定利率 (%)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value.toFixed(1) + ' %';
                        }
                    }
                }
            }
        }
    });
};

window.addEventListener('DOMContentLoaded', () => {
    calculate();
    renderMacroChart(); // 页面加载时绘制宏观利率图表
});
