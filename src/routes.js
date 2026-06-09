export async function registerRoutes(app) {
  app.get('/api/health', async () => ({ ok: true }));
}
