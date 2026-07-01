package com.example.userapi.repository;

import java.util.List;
import java.util.Optional;
import com.example.userapi.model.User;

public interface UserRepository {
    List<User> findAll();
    Optional<User> findById(Long id);
    User save(User user);
    void deleteById(Long id);
}
