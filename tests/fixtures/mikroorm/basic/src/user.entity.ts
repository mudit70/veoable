function Entity(_o?: { tableName?: string }): ClassDecorator { return () => {}; }
function PrimaryKey(): PropertyDecorator { return () => {}; }
function Property(_o?: unknown): PropertyDecorator { return () => {}; }
function ManyToOne(_t: unknown): PropertyDecorator { return () => {}; }

@Entity({ tableName: 'users' })
export class User {
  @PrimaryKey() id!: number;
  @Property() email!: string;
  @Property() name?: string;
}

@Entity()
export class Comment {
  @PrimaryKey() id!: number;
  @Property() body!: string;
  @ManyToOne(() => User) author!: User;
}
