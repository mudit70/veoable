// Minimal stubs for Angular types so ts-morph can parse fixtures.

export function Component(_meta: Record<string, unknown>): ClassDecorator {
  return (_target) => {};
}

export function Injectable(_meta?: Record<string, unknown>): ClassDecorator {
  return (_target) => {};
}

export interface OnInit { ngOnInit(): void; }
export interface OnDestroy { ngOnDestroy(): void; }
export interface OnChanges { ngOnChanges(changes: SimpleChanges): void; }
export interface AfterViewInit { ngAfterViewInit(): void; }
export interface AfterContentInit { ngAfterContentInit(): void; }
export interface DoCheck { ngDoCheck(): void; }

export interface SimpleChanges {
  [propName: string]: { currentValue: unknown; previousValue: unknown; firstChange: boolean };
}
