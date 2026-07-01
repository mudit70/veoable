// JPA entity — patterns a framework-jpa visitor must detect
//
// Detection targets:
//   @Entity → DatabaseTable("orders")
//   @Column → DatabaseColumn
//   @ManyToOne → FOREIGN_KEY edge
//   @OneToMany → relationship

package com.example.orders.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.List;

@Entity
@Table(name = "orders")
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String customerName;

    @Column(precision = 10, scale = 2)
    private BigDecimal total;

    @Enumerated(EnumType.STRING)
    private OrderStatus status = OrderStatus.PENDING;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
    private List<OrderItem> items;

    // getters/setters omitted for brevity
}

enum OrderStatus {
    PENDING, CONFIRMED, SHIPPED, CANCELLED
}
