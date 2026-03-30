/**
 * Data Analyzer — Statistical pre-analysis engine.
 * Computes statistics that are injected into AI prompts for data-accurate output.
 * This is DokuCreator's OWN computation, not AI-generated.
 */

/**
 * Compute basic statistics for a numerical array.
 */
function computeStats(values) {
  const nums = values.filter(v => typeof v === 'number' || (!isNaN(parseFloat(v)) && isFinite(v))).map(Number);
  if (nums.length === 0) return null;

  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  
  const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const min = sorted[0];
  const max = sorted[n - 1];

  // Growth rate: first to last value
  const firstVal = nums[0];
  const lastVal = nums[nums.length - 1];
  const growthRate = firstVal !== 0 ? ((lastVal - firstVal) / Math.abs(firstVal)) * 100 : null;

  // Trend direction using simple linear regression
  const trend = (() => {
    if (nums.length < 3) return 'insufficient_data';
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < nums.length; i++) {
      sumX += i;
      sumY += nums[i];
      sumXY += i * nums[i];
      sumX2 += i * i;
    }
    const slope = (nums.length * sumXY - sumX * sumY) / (nums.length * sumX2 - sumX * sumX);
    const slopeNormalized = slope / (mean || 1);
    if (slopeNormalized > 0.05) return 'increasing';
    if (slopeNormalized < -0.05) return 'decreasing';
    return 'stable';
  })();

  // Outliers: values more than 2 standard deviations from mean
  const outliers = nums
    .map((v, i) => ({ value: v, index: i }))
    .filter(item => Math.abs(item.value - mean) > 2 * stdDev);

  return {
    count: n,
    min: round(min),
    max: round(max),
    mean: round(mean),
    median: round(median),
    stdDev: round(stdDev),
    sum: round(sum),
    growthRate: growthRate !== null ? round(growthRate) : null,
    trend,
    outliers: outliers.map(o => ({ value: round(o.value), index: o.index })),
  };
}

function round(val) {
  return Math.round(val * 100) / 100;
}

/**
 * Analyze a dataset and return per-column statistics + summary.
 * @param {Array} data - Array of data objects
 * @param {string} labelKey - The key used for labels/x-axis
 * @param {string[]} dataKeys - Keys representing numerical data columns
 * @returns {Object} Analysis results
 */
export function analyzeData(data, labelKey, dataKeys) {
  if (!Array.isArray(data) || data.length === 0) {
    return { summary: 'No data to analyze.', columnStats: {} };
  }

  const columnStats = {};
  const insights = [];

  for (const key of dataKeys) {
    const values = data.map(row => row[key]);
    const stats = computeStats(values);
    if (stats) {
      columnStats[key] = stats;

      // Generate human-readable insights
      insights.push(`${key}: ranges from ${stats.min} to ${stats.max} (avg: ${stats.mean})`);
      
      if (stats.growthRate !== null) {
        const direction = stats.growthRate > 0 ? 'increased' : 'decreased';
        insights.push(`  → ${key} ${direction} by ${Math.abs(stats.growthRate)}% from first to last data point`);
      }

      if (stats.trend !== 'insufficient_data') {
        insights.push(`  → Overall trend: ${stats.trend}`);
      }

      if (stats.outliers.length > 0) {
        const outlierVals = stats.outliers.map(o => o.value).join(', ');
        insights.push(`  → Outliers detected: ${outlierVals}`);
      }
    }
  }

  // Cross-column comparisons
  const statEntries = Object.entries(columnStats);
  if (statEntries.length >= 2) {
    const highestAvg = statEntries.reduce((best, [key, stats]) => 
      stats.mean > best.stats.mean ? { key, stats } : best, 
      { key: statEntries[0][0], stats: statEntries[0][1] }
    );
    insights.push(`\nHighest average: ${highestAvg.key} (${highestAvg.stats.mean})`);
  }

  return {
    dataPointCount: data.length,
    columnCount: dataKeys.length,
    labelKey,
    dataKeys,
    columnStats,
    summary: insights.join('\n'),
  };
}

/**
 * Generate a concise analysis summary string that can be injected into AI prompts.
 */
export function generateAnalysisSummaryForPrompt(analysis) {
  if (!analysis || !analysis.columnStats) return '';
  
  const lines = [`Data Analysis Summary (${analysis.dataPointCount} data points, ${analysis.columnCount} metrics):`];
  
  for (const [key, stats] of Object.entries(analysis.columnStats)) {
    lines.push(`- ${key}: min=${stats.min}, max=${stats.max}, avg=${stats.mean}, median=${stats.median}, trend=${stats.trend}`);
    if (stats.growthRate !== null) {
      lines.push(`  Growth: ${stats.growthRate > 0 ? '+' : ''}${stats.growthRate}%`);
    }
    if (stats.outliers.length > 0) {
      lines.push(`  Outliers: ${stats.outliers.map(o => o.value).join(', ')}`);
    }
  }
  
  return lines.join('\n');
}
