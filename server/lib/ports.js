export const PORTS = { API: 5555, UI: 5554 };
export const DEFAULT_PEER_PORT = PORTS.API;
export const PORTOS_UI_URL = process.env.PORTOS_UI_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${process.env.PORT_UI || PORTS.UI}`;
export const PORTOS_API_URL = process.env.PORTOS_API_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${process.env.PORT || PORTS.API}`;
