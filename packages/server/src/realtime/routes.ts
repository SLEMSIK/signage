import type { FastifyInstance } from 'fastify';

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/player', { websocket: true }, (socket, req) => {
    app.ctx.hub.handle(socket, req.ip);
  });

  // Под /api/admin, чтобы браузер прислал cookie сессии (она ограничена этим путём).
  app.get('/api/admin/ws', { websocket: true }, (socket, req) => {
    if (!req.user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    app.ctx.adminHub.handle(socket);
  });
}
