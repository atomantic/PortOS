import { repairPrivateStores } from './469-private-personal-stores.js';

const stores = {
  files: /^$/,
  dirs: {
    'digital-twin': { files: /^(meta|social-accounts)\.json$/ },
    meatspace: { files: /^(epigenetic\.json|genome\.json|genome-raw\.txt)$/ },
    spotify: { files: /^sync-state\.json$/ },
  },
};

export default {
  up: context => repairPrivateStores(context, stores),
};
