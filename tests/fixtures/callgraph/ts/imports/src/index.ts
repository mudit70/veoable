import { helperA, helperB } from './named.js';
import theDefault from './default-export.js';
import * as ns from './namespace-target.js';

export function main() {
  helperA();
  helperB();
  theDefault();
  ns.ns1();
}
