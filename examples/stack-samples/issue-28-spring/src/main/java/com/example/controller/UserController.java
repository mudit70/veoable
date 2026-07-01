package com.example.controller;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping
    public List<String> listUsers() {
        return List.of("Alice", "Bob");
    }

    @GetMapping("/{id}")
    public String getUser(@PathVariable Long id) {
        return "User " + id;
    }

    @PostMapping
    public String createUser(@RequestBody String name) {
        return "Created " + name;
    }

    @PutMapping("/{id}")
    public String updateUser(@PathVariable Long id, @RequestBody String name) {
        return "Updated " + id;
    }

    @DeleteMapping("/{id}")
    public void deleteUser(@PathVariable Long id) {}

    @PatchMapping("/{id}")
    public String patchUser(@PathVariable Long id) {
        return "Patched " + id;
    }
}
