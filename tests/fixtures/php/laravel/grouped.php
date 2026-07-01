<?php

use Illuminate\Support\Facades\Route;

Route::group(['prefix' => 'api'], function () {
    Route::get('/users', [UserController::class, 'index']);
    Route::post('/users', [UserController::class, 'store']);

    Route::group(['prefix' => 'admin'], function () {
        Route::post('/login', [AdminController::class, 'login']);
        Route::get('/profile', [AdminController::class, 'profile']);
    });
});

// Plain top-level route — should NOT pick up any group prefix.
Route::get('/health', [HealthController::class, 'check']);

// Chained-method group syntax: Route::middleware(...)->prefix(...)->group(fn).
// The prefix should still compose onto inner routes.
Route::middleware('auth')->prefix('v1')->group(function () {
    Route::get('/profile', [UserController::class, 'profile']);
});

// Bare prefix-method chain.
Route::prefix('v2')->group(function () {
    Route::get('/teams', [TeamController::class, 'index']);
});
