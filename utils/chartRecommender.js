/**
 * Chart Recommender — Rule-based chart type recommendation engine.
 * This is DokuCreator's OWN logic, not AI-generated.
 * Analyzes data structure to determine optimal chart types.
 */

/**
 * Detect if a column likely contains time-series data.
 */
function isTimeSeriesColumn(values) {
  const timePatterns = [
    /^\d{4}$/,                           // Year: 2020
    /^\d{4}[-\/]\d{1,2}$/,              // 2020-01, 2020/1
    /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/,  // 2020-01-15
    /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/, // 01/15/2020
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,  // month names
    /^q[1-4]\s?\d{0,4}/i,              // Q1, Q1 2020
    /^(mon|tue|wed|thu|fri|sat|sun)/i,  // day names
    /^\d{4}\s?(q[1-4]|h[1-2])/i,       // 2020 Q1, 2020 H1
  ];

  const sampleSize = Math.min(values.length, 10);
  let matchCount = 0;

  for (let i = 0; i < sampleSize; i++) {
    const val = String(values[i]).trim();
    if (timePatterns.some(p => p.test(val))) {
      matchCount++;
    }
  }

  return matchCount / sampleSize > 0.5;
}

/**
 * Detect if a column contains numerical data.
 */
function isNumericalColumn(values) {
  const sampleSize = Math.min(values.length, 10);
  let numCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    const val = values[i];
    if (typeof val === 'number' || (!isNaN(parseFloat(val)) && isFinite(val))) {
      numCount++;
    }
  }
  return numCount / sampleSize > 0.7;
}

/**
 * Analyze data and recommend chart types with confidence scores.
 * @param {Array} data - Array of data objects
 * @param {string} userPreferredType - User's preferred chart type or 'auto'
 * @returns {{ recommendations: Array<{ type: string, score: number, reason: string }>, labelKey: string, dataKeys: string[] }}
 */
export function recommendChartTypes(data, userPreferredType = 'auto') {
  if (!Array.isArray(data) || data.length === 0) {
    return { recommendations: [{ type: 'bar', score: 0.5, reason: 'Default fallback' }], labelKey: '', dataKeys: [] };
  }

  const keys = Object.keys(data[0]);
  const columnAnalysis = {};

  for (const key of keys) {
    const values = data.map(row => row[key]);
    columnAnalysis[key] = {
      isNumerical: isNumericalColumn(values),
      isTimeSeries: isTimeSeriesColumn(values),
      uniqueCount: new Set(values.map(v => String(v))).size,
      values,
    };
  }

  // Identify label key (first non-numerical or time-series column)
  let labelKey = keys.find(k => !columnAnalysis[k].isNumerical) || keys[0];
  const dataKeys = keys.filter(k => columnAnalysis[k].isNumerical && k !== labelKey);

  if (dataKeys.length === 0) {
    // All columns might be numerical — use first as label
    labelKey = keys[0];
    const remaining = keys.slice(1).filter(k => columnAnalysis[k].isNumerical);
    if (remaining.length > 0) dataKeys.push(...remaining);
    else return { recommendations: [{ type: 'bar', score: 0.5, reason: 'Default fallback' }], labelKey, dataKeys: keys.slice(1) };
  }

  // If user specified a type, that's absolute priority
  if (userPreferredType && userPreferredType !== 'auto') {
    return {
      recommendations: [{ type: userPreferredType, score: 1.0, reason: 'User specified this chart type' }],
      labelKey,
      dataKeys,
    };
  }

  // Rule-based scoring
  const recommendations = [];
  const hasTimeSeries = columnAnalysis[labelKey]?.isTimeSeries;
  const categoryCount = columnAnalysis[labelKey]?.uniqueCount || 0;
  const numDataKeys = dataKeys.length;
  const dataPointCount = data.length;

  // Bar chart — good for categorical comparison
  const barScore = (() => {
    let s = 0.6; // Base score — bars are versatile
    if (!hasTimeSeries) s += 0.2;
    if (categoryCount <= 12) s += 0.1;
    if (numDataKeys <= 4) s += 0.1;
    return Math.min(s, 1.0);
  })();
  recommendations.push({ type: 'bar', score: barScore, reason: 'Good for categorical comparison' });

  // Line chart — best for time series and trends
  const lineScore = (() => {
    let s = 0.4;
    if (hasTimeSeries) s += 0.4;
    if (dataPointCount >= 4) s += 0.1;
    if (numDataKeys >= 1 && numDataKeys <= 5) s += 0.1;
    return Math.min(s, 1.0);
  })();
  recommendations.push({ type: 'line', score: lineScore, reason: hasTimeSeries ? 'Time-series data detected — ideal for trend lines' : 'Shows data progression' });

  // Pie chart — part-of-whole, only 1 data key, few categories
  const pieScore = (() => {
    let s = 0.3;
    if (numDataKeys === 1) s += 0.3;
    if (categoryCount <= 7) s += 0.2;
    if (categoryCount > 10) s -= 0.3; // Too many slices = bad pie
    if (numDataKeys > 1) s -= 0.2;
    return Math.max(Math.min(s, 1.0), 0);
  })();
  if (pieScore > 0.3) {
    recommendations.push({ type: 'pie', score: pieScore, reason: 'Part-of-whole comparison with few categories' });
  }

  // Area chart — stacked trends
  const areaScore = (() => {
    let s = 0.4;
    if (hasTimeSeries) s += 0.3;
    if (numDataKeys >= 2) s += 0.2;
    if (dataPointCount >= 4) s += 0.1;
    return Math.min(s, 1.0);
  })();
  recommendations.push({ type: 'area', score: areaScore, reason: 'Good for cumulative/stacked trends' });

  // Composed chart — multiple metrics with different scales
  const composedScore = (() => {
    let s = 0.3;
    if (numDataKeys >= 2) s += 0.3;
    if (numDataKeys >= 3) s += 0.2;
    if (hasTimeSeries) s += 0.1;
    return Math.min(s, 1.0);
  })();
  if (numDataKeys >= 2) {
    recommendations.push({ type: 'composed', score: composedScore, reason: 'Multiple metrics — combined visualization' });
  }

  // Sort by score descending and pick top 2-4
  recommendations.sort((a, b) => b.score - a.score);
  const topRecommendations = recommendations.slice(0, Math.min(4, Math.max(2, recommendations.length)));

  return { recommendations: topRecommendations, labelKey, dataKeys };
}
