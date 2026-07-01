<?php
// Laravel routes — patterns for route detection
//
// Detection targets:
//   Route::apiResource('contacts', ContactController::class) → 5 CRUD endpoints
//   Route::middleware('auth') → scoped middleware
//   Route::prefix('api') → route prefix composition

use App\Http\Controllers\ContactController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->middleware('auth:api')->group(function () {
    // apiResource generates:
    //   GET    /api/contacts       → ContactController@index
    //   POST   /api/contacts       → ContactController@store
    //   GET    /api/contacts/{id}  → ContactController@show
    //   PUT    /api/contacts/{id}  → ContactController@update
    //   DELETE /api/contacts/{id}  → ContactController@destroy
    Route::apiResource('contacts', ContactController::class);
});
