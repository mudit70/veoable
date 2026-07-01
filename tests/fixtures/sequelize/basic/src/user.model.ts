// Stubs so the fixture compiles without sequelize-typescript.
function Table(_o?: { tableName?: string } | string): ClassDecorator { return () => {}; }
function Column(_o?: unknown): PropertyDecorator { return () => {}; }
function PrimaryKey(): PropertyDecorator { return () => {}; }
function AutoIncrement(): PropertyDecorator { return () => {}; }
class Model {
  static async findOne(_o?: unknown): Promise<unknown> { return null; }
  static async findAll(_o?: unknown): Promise<unknown[]> { return []; }
  static async findByPk(_id: unknown): Promise<unknown> { return null; }
  static async create(_v: unknown): Promise<unknown> { return {}; }
  static async update(_v: unknown, _w: unknown): Promise<unknown> { return {}; }
  static async destroy(_o: unknown): Promise<unknown> { return {}; }
  static async count(_o?: unknown): Promise<number> { return 0; }
}

@Table({ tableName: 'users' })
export class User extends Model {
  @PrimaryKey @AutoIncrement @Column declare id: number;
  @Column declare email: string;
  @Column declare name?: string;
}

// Plain class extending Model (no @Table) — should default to
// pluralised lowercase ("photos").
export class Photo extends Model {
  @Column declare url: string;
}

// Irregular plural via the explicit map.
export class Person extends Model {
  @Column declare name: string;
}
