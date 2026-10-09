/** Bảng tra route tối giản. GET để đọc, PATCH chỉ cho sửa cấu hình agent. */
export function createRouter() {
  const routes = [];

  function register(method) {
    return (pattern, handler) => {
      routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    };
  }

  const get = register('GET');
  const patch = register('PATCH');
  const post = register('POST');

  function resolve(pathname, method = 'GET') {
    const segs = pathname.split('/').filter(Boolean);
    // Route ÍT tham số khớp trước: /api/agents/:id không được nuốt một route
    // tĩnh cùng độ dài nếu sau này có.
    const ordered = routes
      .filter(r => r.method === method)
      .sort((a, b) => countParams(a.parts) - countParams(b.parts));

    for (const route of ordered) {
      if (route.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  return { get, patch, post, resolve };
}

function countParams(parts) {
  return parts.filter(p => p.startsWith(':')).length;
}
