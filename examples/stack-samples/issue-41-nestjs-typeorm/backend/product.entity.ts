// TypeORM entity — patterns a framework-typeorm visitor must detect
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column('decimal')
  price!: number;

  @Column({ default: true })
  isActive!: boolean;

  @ManyToOne(() => Category, (cat) => cat.products)
  category!: Category;
}

@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  products!: Product[];
}
