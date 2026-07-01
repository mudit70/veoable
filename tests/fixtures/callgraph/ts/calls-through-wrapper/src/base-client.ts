// The bottom of the wrapper chain — pretend this is fetch().
export function baseGet(url: string) {
  return { url };
}
