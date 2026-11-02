const form = document.querySelector('#prompt-form');
const input = document.querySelector('#prompt');
const send = document.querySelector('#send');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');

function addMessage(text, role) {
  const node = document.createElement('div');
  node.className = `message ${role}`;
  node.textContent = text;
  messages.append(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return node;
}

async function submitPrompt(prompt) {
  const text = prompt.trim();
  if (!text || send.disabled) return;
  welcome.hidden = true;
  addMessage(text, 'user');
  input.value = '';
  send.disabled = true;
  const pending = addMessage('Codex 正在思考…', 'assistant');
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '请求失败');
    pending.textContent = result.answer;
  } catch (error) {
    pending.classList.add('error');
    pending.textContent = error.message;
  } finally {
    send.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void submitPrompt(input.value);
});
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => void submitPrompt(button.dataset.prompt));
});

