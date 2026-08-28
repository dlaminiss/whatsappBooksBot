const Anthropic = require('@anthropic-ai/sdk');
const { toolSchemas, executors } = require('./tools');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a helpful assistant embedded in a WhatsApp chat, managing a books/authors SQLite database for the user.

Capabilities:
- Add authors and books (add_author, add_book)
- Update or delete books/authors (update_book, delete_book, delete_author)
- Answer any question about the data using run_sql_select (joins, filters, counts, "who wrote X", "list all books by Y", etc.)

Rules:
- Always use tools to check or change the database — never guess at data you haven't looked up.
- When adding a book, you don't need to check if the author exists first; add_book creates the author automatically.
- If a user's request is ambiguous (e.g. deleting when multiple books/authors could match), ask a short clarifying question instead of guessing.
- Keep replies short and WhatsApp-appropriate: plain text, no markdown headers, minimal formatting. Use line breaks and dashes for lists, not markdown tables.
- After a write (add/update/delete), briefly confirm what was done.
- If a query returns no results, say so plainly rather than assuming.
- If asked something unrelated to the books/authors database, politely say this bot only handles the books/authors database.`;

// In-memory per-sender conversation history: { [senderId]: [{role, content}, ...] }
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20; // keep last N messages (user+assistant) per sender

function getHistory(senderId) {
  if (!conversations.has(senderId)) conversations.set(senderId, []);
  return conversations.get(senderId);
}

function trimHistory(history) {
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

async function handleMessage(senderId, userText) {
  const history = getHistory(senderId);
  history.push({ role: 'user', content: userText });

  let loopGuard = 0;
  while (loopGuard < 8) {
    loopGuard += 1;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages: history,
    });

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b) => b.type === 'text');
      trimHistory(history);
      return textBlock ? textBlock.text : "Sorry, I didn't get a response — try again.";
    }

    // Execute every tool_use block in this response, collect tool_results
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const executor = executors[block.name];
      let resultContent;
      try {
        const result = executor ? executor(block.input) : { error: `Unknown tool: ${block.name}` };
        resultContent = JSON.stringify(result);
      } catch (err) {
        resultContent = JSON.stringify({ error: err.message });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultContent,
      });
    }

    history.push({ role: 'user', content: toolResults });
  }

  trimHistory(history);
  return "Sorry, that request got too complicated — could you rephrase or break it into smaller steps?";
}

function resetHistory(senderId) {
  conversations.delete(senderId);
}

module.exports = { handleMessage, resetHistory };
