import { WebSocket, WebSocketServer } from 'ws'

const clients = new Set<WebSocket>()

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })
}

export function broadcast(message: object) {
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}