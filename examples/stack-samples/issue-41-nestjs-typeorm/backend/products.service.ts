// NestJS service with TypeORM repository — patterns for framework-typeorm
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepo: Repository<Product>,
  ) {}

  findAll(): Promise<Product[]> {
    // TypeORM: repository.find() → DatabaseInteraction(read, table: Product)
    return this.productsRepo.find({ relations: ['category'] });
  }

  findOne(id: number): Promise<Product | null> {
    // TypeORM: repository.findOneBy() → DatabaseInteraction(read, table: Product)
    return this.productsRepo.findOneBy({ id });
  }

  create(name: string, price: number): Promise<Product> {
    // TypeORM: repository.save() → DatabaseInteraction(write, table: Product)
    const product = this.productsRepo.create({ name, price });
    return this.productsRepo.save(product);
  }

  async remove(id: number): Promise<void> {
    // TypeORM: repository.delete() → DatabaseInteraction(delete, table: Product)
    await this.productsRepo.delete(id);
  }

  async updatePrice(id: number, price: number): Promise<void> {
    // TypeORM: repository.update() → DatabaseInteraction(write, table: Product)
    await this.productsRepo.update(id, { price });
  }
}
