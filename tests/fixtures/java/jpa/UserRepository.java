package com.example;

import java.util.List;
import java.util.Optional;

public interface UserRepository {
    List<Object> findAll();
    Optional<Object> findById(Long id);
    Object save(Object entity);
    void deleteById(Long id);
    List<Object> findByEmail(String email);
    List<Object> findByActiveAndRole(boolean active, String role);
    long count();
    boolean existsById(Long id);
}
