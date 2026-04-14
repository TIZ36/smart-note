const pages = document.querySelectorAll('.page')
const navButtons = document.querySelectorAll('.nav-btn')

function showPage(page) {
  pages.forEach((p) => p.classList.toggle('active', p.id === `page-${page}`))
  navButtons.forEach((b) => b.classList.toggle('active', b.dataset.page === page))
}

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page))
})

async function refreshHealth() {
  const gatewayStatus = document.getElementById('gateway-status')
  const embedMode = document.getElementById('embed-mode')
  try {
    const res = await fetch('http://127.0.0.1:8787/health')
    const data = await res.json()
    gatewayStatus.textContent = data.status
    embedMode.textContent = data.embedding_mode
  } catch {
    gatewayStatus.textContent = 'offline'
    embedMode.textContent = 'unknown'
  }
}

async function runSearch(path, body) {
  const out = document.getElementById('search-output')
  out.textContent = 'Loading...'
  try {
    const res = await fetch(`http://127.0.0.1:8787/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    out.textContent = JSON.stringify(data, null, 2)
  } catch (err) {
    out.textContent = `Request failed: ${err}`
  }
}

document.getElementById('search-btn')?.addEventListener('click', () => {
  const query = document.getElementById('search-query').value
  runSearch('search', { query, topk: 5 })
})

document.getElementById('chat-btn')?.addEventListener('click', () => {
  const query = document.getElementById('search-query').value
  runSearch('chat', { query, topk: 5 })
})

refreshHealth()
