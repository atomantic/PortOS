/** Route map limits and headings (lib/musicVideoRouteMaps.js), a leaf so validation stays narrow. */
export const ROUTE_MAP_MAX = 12;
export const ROUTE_MAP_STOPS_MAX = 24;
export const ROUTE_MAP_NAME_MAX = 120;
export const ROUTE_MAP_TRAVEL_MAX = 500;
export const ROUTE_MAP_NOTE_MAX = 500;
export const ROUTE_MAP_HEADINGS = Object.freeze(['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']);
export const ROUTE_MAP_FEATURES_MAX = 12;
export const ROUTE_MAP_FEATURE_LABEL_MAX = 120;
// What a stretch has beside it: a side street turning off, or a landmark such as a derelict house.
export const ROUTE_MAP_FEATURE_KINDS = Object.freeze(['side-street', 'landmark']);
// Which side of the travellers it is on, as they travel the route.
export const ROUTE_MAP_FEATURE_SIDES = Object.freeze(['left', 'right', 'ahead']);
