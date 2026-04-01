import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import Groq from 'groq-sdk';
import auth from '../middleware/auth.js';
import { recommendChartTypes } from '../utils/chartRecommender.js';
import { analyzeData, generateAnalysisSummaryForPrompt } from '../utils/dataAnalyzer.js';

const router = express.Router();

const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({ apiKey });
};

const getGroqClient = () => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null; // Fallback to Gemini if no Groq key
  return new Groq({ apiKey });
};

// ========== CHART GENERATION ==========

const chartDefinitionProperties = {
  title: { type: Type.STRING, description: 'A descriptive, professional title for the chart that includes context and key metric.' },
  chartType: { type: Type.STRING, description: "The type of chart. Must be one of: 'bar', 'line', 'pie', 'area', 'composed'." },
  data: {
    type: Type.STRING,
    description: 'A JSON string representing the array of data objects for the chart. Each object must have key-value pairs.',
  },
  labelKey: { type: Type.STRING, description: 'The key in the data objects to be used for labels (e.g., x-axis).' },
  dataKeys: {
    type: Type.ARRAY,
    description: 'An array of keys in the data objects that represent the numerical values to be plotted.',
    items: { type: Type.STRING },
  },
};

const chartGenerationSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: chartDefinitionProperties,
    required: ['title', 'chartType', 'data', 'labelKey', 'dataKeys'],
  },
};

router.post('/charts', auth, async (req, res) => {
  try {
    const { textData, fileData, chartPreferences, preferredChartType, chartVariants } = req.body;

    if (!textData?.trim() && !fileData) {
      return res.status(400).json({ error: 'Please provide data to analyze.' });
    }

    // Step 1: Parse file data if provided
    let extractedFileText = '';
    if (fileData) {
      const { base64, mimeType } = fileData;
      const buffer = Buffer.from(base64, 'base64');

      if (mimeType === 'text/csv' || mimeType === 'text/plain') {
        // CSV/Text: just decode to string
        extractedFileText = buffer.toString('utf-8');
      } else if (
        mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mimeType === 'application/vnd.ms-excel'
      ) {
        // Excel: parse with xlsx and convert to CSV
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        extractedFileText = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      } else {
        // PDF, Word, etc. — Gemini supports these natively
        extractedFileText = null; // will send as inlineData instead
      }
    }

    // Combine text sources
    const combinedText = [textData, extractedFileText].filter(Boolean).join('\n\n');

    // Step 2: Try to parse combined data for local analysis
    let localAnalysis = null;
    let recommendations = null;

    if (combinedText.trim()) {
      const parsedData = tryParseTabularData(combinedText);
      if (parsedData && parsedData.length > 0) {
        recommendations = recommendChartTypes(parsedData, preferredChartType || 'auto');
        localAnalysis = analyzeData(parsedData, recommendations.labelKey, recommendations.dataKeys);
      }
    }

    // Step 3: Build enhanced prompt
    const numVariants = chartVariants || (recommendations ? recommendations.recommendations.length : 3);

    let prompt = `You are an elite data visualization expert at a top consulting firm. Analyze the following data and create exactly ${numVariants} powerful, insightful chart suggestions.\n\n`;

    // Inject chart type constraints
    if (preferredChartType && preferredChartType !== 'auto') {
      prompt += `**ABSOLUTE PRIORITY: The user has specifically requested '${preferredChartType}' chart type. ALL chart suggestions MUST be of type '${preferredChartType}'. Do NOT generate any other chart type. You may vary the data keys or groupings to show different perspectives, but the chartType MUST be '${preferredChartType}'.**\n\n`;
    } else if (recommendations) {
      const typeList = recommendations.recommendations.map(r => `'${r.type}' (reason: ${r.reason})`).join(', ');
      prompt += `System data analysis recommends these chart types: ${typeList}. Generate one chart per recommended type. Follow these recommendations.\n\n`;
    }

    // Inject statistical analysis
    if (localAnalysis) {
      const analysisSummary = generateAnalysisSummaryForPrompt(localAnalysis);
      prompt += `**Pre-computed Data Analysis (use these EXACT numbers in titles/annotations, do NOT re-calculate):**\n${analysisSummary}\n\n`;
    }

    prompt += `**Title Requirements:** Each title must be professional and contextual — NOT generic like "Sales Chart". Instead: "Quarterly Revenue Growth: +23.4% YoY Performance Analysis". Include key metrics in titles when possible.\n\n`;
    prompt += `The chartType must be one of: 'bar', 'line', 'pie', 'area', 'composed'.\nFor 'pie' charts, ensure dataKeys has only one key.\nThe 'data' property MUST be a valid JSON string representing an array of objects.\n`;

    if (chartPreferences) {
      prompt += `\nUser preferences: "${chartPreferences}"\n`;
    }

    const textPart = { text: prompt + (combinedText ? `\n\nData:\n\`\`\`\n${combinedText}\n\`\`\`` : '') };
    const parts = [textPart];

    // Only send as inlineData for MIME types Gemini supports natively (PDF, images, etc.)
    if (fileData && extractedFileText === null) {
      parts.push({
        inlineData: {
          data: fileData.base64,
          mimeType: fileData.mimeType,
        },
      });
    }

    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: chartGenerationSchema,
      },
    });

    const jsonText = response.text.trim();
    const result = JSON.parse(jsonText);

    if (!Array.isArray(result)) {
      throw new Error('AI response is not an array.');
    }

    const charts = result.map(chart => {
      if (typeof chart.data === 'string') {
        try { chart.data = JSON.parse(chart.data); } catch { chart.data = []; }
      }
      return chart;
    });

    res.json({
      charts,
      analysis: localAnalysis, // Send analysis to frontend for annotations
      recommendations: recommendations?.recommendations,
    });
  } catch (error) {
    console.error('Chart generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate charts.' });
  }
});

// ========== SLIDE GENERATION ==========

const slideGenerationSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'The main title for the slide.' },
    content: {
      type: Type.ARRAY,
      description: 'An array of strings. Each string is one bullet point.',
      items: { type: Type.STRING },
    },
    chart: {
      type: Type.OBJECT,
      properties: chartDefinitionProperties,
      description: 'A chart definition if the user provided data to visualize.',
    },
    style: {
      type: Type.OBJECT,
      description: 'A suggested professional style for the slide.',
      properties: {
        font: { type: Type.STRING },
        color: { type: Type.STRING },
        backgroundColor: { type: Type.STRING },
        colorPaletteName: { type: Type.STRING },
      },
    },
  },
  required: ['title', 'content'],
};

router.post('/slides', auth, async (req, res) => {
  try {
    const {
      description,
      selectedChart,
      themeHint,
      template,
      bulletCount,
      analysisDepth,
      tone,
    } = req.body;

    const numPoints = bulletCount || 5;
    const depth = analysisDepth || 'Detailed';
    const toneStyle = tone || 'Professional';
    const slideTemplate = template || 'data-deep-dive';

    // Build enhanced prompt
    let prompt = `You are a SENIOR BUSINESS ANALYST at McKinsey & Company. Generate a single, powerful slide.\n\n`;

    // Template-specific instructions
    const templateInstructions = {
      'executive-summary': 'Layout: Large title, 3-4 key metrics with percentage changes, concluding statement. Focus on high-level strategic takeaways.',
      'data-deep-dive': 'Layout: Chart on one side, detailed insights on the other. Each point must deeply analyze a specific aspect of the data.',
      'comparison': 'Layout: Two-column comparison (before/after, A vs B, or pros/cons). Use comparative language and quantify differences.',
      'title-slide': 'Layout: Full-screen title with a compelling subtitle and date. Keep content minimal but impactful.',
      'key-findings': 'Layout: Numbered key findings (1., 2., 3...). Each finding must stand alone as an insight. Start each with an action verb.',
      'dashboard': 'Layout: Multiple metrics in a grid-like format. Include key performance indicators with directional arrows (↑↓→).',
      'conclusion': 'Layout: Summary of key points followed by clear calls-to-action or next steps.',
    };

    prompt += `**Slide Template:** ${slideTemplate}\n${templateInstructions[slideTemplate] || templateInstructions['data-deep-dive']}\n\n`;
    prompt += `**Generate exactly ${numPoints} bullet points.**\n`;
    prompt += `**Analysis Depth:** ${depth}\n`;
    prompt += `**Tone:** ${toneStyle}\n\n`;

    prompt += `**CRITICAL RULES FOR BULLET POINTS:**\n`;
    prompt += `1. Each bullet MUST contain at least one QUANTIFIED METRIC (percentage, growth rate, exact number, or comparison)\n`;
    prompt += `2. Structure: [Factual Data Point] → [Business Implication] → [Recommendation or Forward-looking Insight]\n`;
    prompt += `3. Use precise numbers from the data — do NOT round excessively or generalize\n`;
    prompt += `4. Each bullet should be self-contained and independently valuable\n`;
    prompt += `5. Use professional business language: "revenue uplift", "margin compression", "YoY growth", "market penetration"\n\n`;

    if (depth === 'Executive') {
      prompt += `**Executive depth:** Focus on strategic implications, market positioning, and bottom-line impact. Every point should be boardroom-ready.\n\n`;
    } else if (depth === 'Summary') {
      prompt += `**Summary depth:** Keep points concise — max 2 sentences each. Focus on the most important takeaways only.\n\n`;
    }

    prompt += `**Style:** The user is favoring a '${themeHint || 'default'}' theme. Match your suggested colorPaletteName to this.\n\n`;
    prompt += `**User's slide description:**\n---\n${description}\n---\n`;

    // If chart data is provided, run local analysis and inject it
    if (selectedChart) {
      const chartData = selectedChart.chart.data;
      const labelKey = selectedChart.chart.labelKey;
      const dataKeys = selectedChart.chart.dataKeys;

      if (Array.isArray(chartData) && chartData.length > 0) {
        const analysis = analyzeData(chartData, labelKey, dataKeys);
        const summary = generateAnalysisSummaryForPrompt(analysis);

        prompt += `\n**PRE-COMPUTED DATA ANALYSIS (use these EXACT numbers — do NOT hallucinate):**\n${summary}\n\n`;
      }

      prompt += `\nThe user has provided an existing chart. DO NOT generate a new chart definition.\n`;
      prompt += `**Chart Title:** "${selectedChart.chart.title}"\n`;
      prompt += `**Chart Data:**\n\`\`\`json\n${JSON.stringify(selectedChart.chart.data, null, 2)}\n\`\`\`\n`;
    }

    // Try Groq first, fallback to Gemini
    const groq = getGroqClient();
    let result;

    if (groq) {
      const slideSystemPrompt = `You are a SENIOR BUSINESS ANALYST. You MUST respond with valid JSON only. The JSON must have this structure: { "title": "string", "content": ["bullet1", "bullet2", ...], "style": { "font": "string", "color": "#hex", "backgroundColor": "#hex", "colorPaletteName": "string" } }. Do NOT include a "chart" field unless explicitly asked.`;

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: slideSystemPrompt },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4096,
      });

      result = JSON.parse(completion.choices[0].message.content);
    } else {
      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: slideGenerationSchema,
        },
      });
      result = JSON.parse(response.text.trim());
    }

    if (result.chart && typeof result.chart.data === 'string') {
      try { result.chart.data = JSON.parse(result.chart.data); } catch { result.chart = undefined; }
    }

    res.json(result);
  } catch (error) {
    console.error('Slide generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate slide.' });
  }
});

// ========== COLOR PALETTE GENERATION ==========

router.post('/color-palette', auth, async (req, res) => {
  try {
    const { description, backgroundColor } = req.body;

    const prompt = `You are a color theme expert. Generate 6 visually appealing and contrasting hex color codes.
Background color: ${backgroundColor}.
User preference: "${description}".
Response: JSON object with key "colors" containing exactly 6 hex strings.`;

    const schema = {
      type: Type.OBJECT,
      properties: {
        colors: { type: Type.ARRAY, items: { type: Type.STRING }, description: '6 hex color codes.' },
      },
      required: ['colors'],
    };

    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: schema },
    });

    const result = JSON.parse(response.text.trim());
    if (!result.colors || result.colors.length < 6) {
      throw new Error('Invalid color palette response.');
    }
    res.json(result);
  } catch (error) {
    console.error('Color palette error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate palette.' });
  }
});

// ========== REPORT GENERATION ==========

router.post('/reports', auth, async (req, res) => {
  try {
    const { details, components, pageCount, reportStyle } = req.body;

    if (!details?.trim()) {
      return res.status(400).json({ error: 'Please provide report details.' });
    }
    if (!components || components.length === 0) {
      return res.status(400).json({ error: 'Please select at least one component.' });
    }

    const style = reportStyle || 'Business Executive';
    const componentList = components.map(c => ` - ${c.charAt(0).toUpperCase() + c.slice(1)}`).join('\n');

    const systemInstruction = `You are an expert professional report writer producing ${style}-level documents.

**Strict Formatting Requirements:**
1. Output MUST be a single block of clean HTML.
2. Include this EXACT <style> block at the beginning:
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
      body { font-family: 'Inter', Arial, sans-serif; line-height: 1.8; color: #1a1a2e; }
      h1 { text-align: center; font-size: 2.5em; margin-bottom: 0.3em; color: #16213e; font-weight: 700; }
      h1 + p.subtitle { text-align: center; font-size: 1.1em; color: #666; margin-bottom: 2em; font-style: italic; }
      h2 { font-size: 1.8em; border-bottom: 3px solid #0f3460; padding-bottom: 0.3em; margin-top: 2em; color: #0f3460; page-break-before: always; font-weight: 600; }
      h3 { font-size: 1.3em; color: #16213e; margin-top: 1.5em; font-weight: 600; }
      h2:first-of-type { page-break-before: auto; }
      p { margin-bottom: 1em; text-align: justify; }
      ul, ol { list-style-position: inside; padding-left: 1.5em; margin-bottom: 1em; }
      li { margin-bottom: 0.5em; }
      b, strong { color: #0f3460; }
      
      /* Key Findings Callout Box */
      .callout { background: #f0f4ff; border-left: 4px solid #0f3460; padding: 1em 1.5em; margin: 1.5em 0; border-radius: 0 8px 8px 0; }
      .callout h4 { color: #0f3460; margin: 0 0 0.5em 0; font-size: 1.1em; }
      
      /* Metric Highlight Box */
      .metric-box { display: inline-block; background: #e8f0fe; border: 1px solid #c2d6f2; border-radius: 8px; padding: 0.8em 1.2em; margin: 0.3em; text-align: center; min-width: 140px; }
      .metric-box .value { font-size: 1.8em; font-weight: 700; color: #0f3460; display: block; }
      .metric-box .label { font-size: 0.85em; color: #666; display: block; margin-top: 0.2em; }
      
      /* Data Tables */
      table { width: 100%; border-collapse: collapse; margin: 1.5em 0; font-size: 0.95em; }
      th { background: #0f3460; color: white; padding: 0.8em 1em; text-align: left; font-weight: 600; }
      td { padding: 0.7em 1em; border-bottom: 1px solid #e0e0e0; }
      tr:nth-child(even) td { background: #f8f9fa; }
      tr:hover td { background: #e8f0fe; }
      
      /* Inline Charts (HTML/CSS-based) */
      .bar-chart { margin: 1.5em 0; }
      .bar-chart .bar-row { display: flex; align-items: center; margin-bottom: 0.4em; }
      .bar-chart .bar-label { width: 120px; font-size: 0.9em; color: #333; flex-shrink: 0; }
      .bar-chart .bar-track { flex-grow: 1; background: #eee; border-radius: 4px; height: 24px; overflow: hidden; }
      .bar-chart .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #0f3460, #3a86ff); display: flex; align-items: center; padding: 0 8px; }
      .bar-chart .bar-value { font-size: 0.8em; color: white; font-weight: 600; white-space: nowrap; }
      
      /* Flow Diagrams */
      .flow-diagram { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.5em; margin: 1.5em 0; }
      .flow-step { background: #0f3460; color: white; padding: 0.6em 1.2em; border-radius: 8px; font-size: 0.9em; font-weight: 500; }
      .flow-arrow { font-size: 1.5em; color: #0f3460; }
      
      /* Figure Captions */
      .figure { margin: 1.5em 0; text-align: center; }
      .figure figcaption { font-size: 0.85em; color: #666; margin-top: 0.5em; font-style: italic; }
    </style>
3. Use <h1> for the main title. Add a <p class="subtitle"> immediately after with a subtitle.
4. Use <h2> for major sections. Each starts on a new page.
5. Use <h3> for subsections.
6. Intelligently use <b>, <i>, and styled elements for emphasis.
7. If 'contents' is requested, generate an HTML Table of Contents with anchor links.
8. Output ONLY the HTML content, NO <html>, <head>, or <body> tags.

**EMBEDDED VISUALIZATIONS (CRITICAL):**
When discussing data or comparisons, you MUST embed inline HTML visualizations:
- Use <div class="metric-box"> for key statistics (with .value and .label spans)
- Use <div class="bar-chart"> for comparative data (horizontal bar charts using CSS widths)
- Use <table> for tabular data with proper <th> and <td>
- Use <div class="callout"> for key findings or important highlights
- Use <div class="flow-diagram"> for process flows with .flow-step and .flow-arrow
- Use <div class="figure"><figcaption>Figure N: Description</figcaption></div> for figure captions

Generate at least 2-3 embedded visualizations throughout the report. These should be part of the analysis, not decorative.

**Content Requirements:**
1. ONLY include sections the user explicitly requested in the 'Report Components' list.
2. Target report length: approximately ${pageCount} pages.
   - If source material is INSUFFICIENT for ${pageCount} pages: expand with deeper analysis, examples, case studies, industry benchmarks, best practices, implications, and future recommendations.
   - If source material EXCEEDS the target: prioritize key findings, condense supporting details, and summarize secondary information.
3. Writing style: ${style}`;

    const userPrompt = `Generate a report.\n\n**Report Components:**\n${componentList}\n\n**Target Length:** ${pageCount} pages.\n\n**Report Style:** ${style}\n\n**Main Content:**\n---\n${details}\n---`;

    // Try Groq first, fallback to Gemini
    const groq = getGroqClient();
    let htmlContent;

    if (groq) {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 8192,
      });
      htmlContent = completion.choices[0].message.content;
    } else {
      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: userPrompt,
        config: {
          systemInstruction: systemInstruction,
        },
      });
      htmlContent = response.text;
    }

    res.json({ html: htmlContent });
  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate report.' });
  }
});

// ========== Helper: Try to parse text as tabular data ==========

function tryParseTabularData(text) {
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return null;

    // Try comma-separated
    let separator = ',';
    if (lines[0].includes('\t')) separator = '\t';
    else if (lines[0].includes(';')) separator = ';';
    else if (!lines[0].includes(',') && lines[0].includes('|')) separator = '|';

    const headers = lines[0].split(separator).map(h => h.trim().replace(/"/g, ''));
    if (headers.length < 2) return null;

    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(separator).map(v => v.trim().replace(/"/g, ''));
      if (values.length !== headers.length) continue;

      const row = {};
      headers.forEach((h, idx) => {
        const val = values[idx];
        const num = parseFloat(val);
        row[h] = (!isNaN(num) && isFinite(num) && val.match(/^-?\d/)) ? num : val;
      });
      data.push(row);
    }

    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

export default router;
