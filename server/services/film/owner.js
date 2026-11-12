/** Owner identity scopes jobs across domains, independent of adapter object identity. */
export const filmOwnerKey = (owner) => JSON.stringify([owner.kind, owner.id]);
