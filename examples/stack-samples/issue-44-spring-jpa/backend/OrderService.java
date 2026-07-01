// Spring service with JPA repository — patterns for framework-jpa
//
// Detection targets:
//   orderRepository.findAll() → DatabaseInteraction(read, orders)
//   orderRepository.findById() → DatabaseInteraction(read, orders)
//   orderRepository.save() → DatabaseInteraction(write, orders)
//   orderRepository.deleteById() → DatabaseInteraction(delete, orders)

package com.example.orders.service;

import com.example.orders.model.Order;
import com.example.orders.model.OrderStatus;
import com.example.orders.repository.OrderRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;

@Service
public class OrderService {

    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public List<Order> findAll() {
        return orderRepository.findAll();
    }

    public Order findById(Long id) {
        return orderRepository.findById(id)
            .orElseThrow(() -> new RuntimeException("Order not found"));
    }

    @Transactional
    public Order create(CreateOrderRequest request) {
        Order order = new Order();
        order.setCustomerName(request.customerName());
        order.setTotal(request.calculateTotal());
        return orderRepository.save(order);
    }

    @Transactional
    public Order cancel(Long id) {
        Order order = findById(id);
        order.setStatus(OrderStatus.CANCELLED);
        return orderRepository.save(order);
    }

    @Transactional
    public void delete(Long id) {
        orderRepository.deleteById(id);
    }
}
