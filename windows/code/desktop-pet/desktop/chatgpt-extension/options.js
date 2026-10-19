document.getElementById('pair').addEventListener('click', async () => {
  const button = document.getElementById('pair'); button.disabled = true;
  try { const result = await chrome.runtime.sendMessage({ action: 'pair', code: document.getElementById('code').value.trim() }); document.getElementById('status').textContent = result.error ?? '已配对，回到 AIKI 检查连接。'; }
  catch (error) { document.getElementById('status').textContent = String(error); }
  finally { button.disabled = false; }
});
