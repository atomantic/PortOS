// The open Prompt Manager record lives in the URL (`?stage=` / `?var=` /
// `?skill=`) so it is deep-linkable and reload-safe. Selecting is a PUSH, so
// Back returns to the previously-open record — matching Authors/Music/Sharing.
// Other params (another tab's open record) are left untouched.
import { useSearchParams } from 'react-router';

export default function useSelectionParam(key) {
  const [searchParams, setSearchParams] = useSearchParams();
  const select = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };
  return [searchParams.get(key), select];
}
