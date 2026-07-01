import requests

def fetch_users():
    return requests.get("http://localhost/api/users")

def main():
    users = fetch_users()
    print(users)

if __name__ == '__main__':
    main()
