const path = require('path');

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function createCloudSync() {
  const supabaseUrl = trimSlash(process.env.SUPABASE_URL);
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || 'rhythm-game-assets');
  const stateId = String(process.env.SUPABASE_STATE_ID || 'main');
  const enabled = Boolean(supabaseUrl && serviceRoleKey);

  function headers(extra = {}) {
    return {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...extra
    };
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
    }
    return response;
  }

  async function loadState() {
    if (!enabled) return null;
    const url = `${supabaseUrl}/rest/v1/rhythm_game_state?id=eq.${encodeURIComponent(stateId)}&select=payload`;
    const response = await request(url, { headers: headers() });
    const rows = await response.json();
    return rows[0]?.payload || null;
  }

  async function saveState(payload) {
    if (!enabled) return;
    const url = `${supabaseUrl}/rest/v1/rhythm_game_state`;
    await request(url, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify([{ id: stateId, payload, updated_at: new Date().toISOString() }])
    });
  }

  async function uploadAsset({ category, fileName, buffer, mimeType }) {
    if (!enabled) return null;
    const objectPath = `${category}/${fileName}`;
    const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    await request(url, {
      method: 'POST',
      headers: headers({
        'Content-Type': mimeType || 'application/octet-stream',
        'x-upsert': 'true'
      }),
      body: buffer
    });
    return {
      url: `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
      cloudPath: objectPath
    };
  }

  async function deleteAsset(asset) {
    if (!enabled || !asset?.cloudPath) return;
    const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`;
    await request(url, {
      method: 'DELETE',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [asset.cloudPath] })
    });
  }

  return {
    enabled,
    mode: enabled ? 'supabase' : 'local',
    bucket,
    loadState,
    saveState,
    uploadAsset,
    deleteAsset
  };
}

module.exports = { createCloudSync };
