from .models import Article


def list_articles():
    # ORM read.
    return Article.objects.all()


def get_article(pk):
    # ORM read with filter.
    return Article.objects.filter(pk=pk).first()


def create_article(title):
    # ORM write.
    return Article.objects.create(title=title)


def delete_article(pk):
    article = Article.objects.get(pk=pk)
    article.delete()
