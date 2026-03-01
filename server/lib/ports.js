export const PORTS = { API: 5555, UI: 5554 };
export const DEFAULT_PEER_PORT = PORTS.API;
export const PORTOS_UI_URL = process.env.PORTOS_UI_URL
  || `http://localhost:${process.env.PORT_UI || PORTS.UI}`;
