package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping
    public String list() { return "[]"; }

    @GetMapping("/{id}")
    public String get(@PathVariable Long id) { return "{}"; }

    @PostMapping
    public String create() { return "{}"; }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {}
}
