/**
 * AI Chatbot Module
 * Provides intelligent assistance using Claude API
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export async function chat(message, context = {}) {
  if (!ANTHROPIC_API_KEY) {
    return { reply: 'AI assistant is not configured. Please set ANTHROPIC_API_KEY.' };
  }

  const systemPrompt = `You are an AI assistant for municipal-performance-management-system, built by AllIR Solutions.
Comprehensive automated performance management system for South African municipal operations to track, analyze, and manage organizational KPIs, departmental metrics, and compliance standards over a 3-year implementation period
Help users understand and use this system effectively.
- Explain KPI calculations and interpretations\n- Provide guidance on municipal compliance standards\n- Assist with report generation and interpretation\n- Answer questions about performance trends\n- Help with system navigation and feature usage\n- Suggest performance improvement strategies\n- Provide regulatory update information\n- Generate executive summaries of performance data`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    const data = await res.json();
    return { reply: data.content?.[0]?.text || 'Sorry, I could not process that.' };
  } catch (e) {
    return { reply: `AI error: ${e.message}` };
  }
}
