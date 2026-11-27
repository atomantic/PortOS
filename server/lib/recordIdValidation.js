/** Build a record ID assertion shared by file and PostgreSQL store facades. */
export function createIdValidator(storeName, pattern) {
  return id => {
    if (typeof id !== 'string' || !pattern.test(id)) {
      throw new Error(`${storeName}: invalid record id "${id}" — must match ${pattern}`);
    }
  };
}
