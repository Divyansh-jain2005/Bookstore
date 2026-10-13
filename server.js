const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

const app = express();
const port = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});

const upload = multer({ storage });

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/bookstore';
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || '1234';
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const adminSessionLifetime = 8 * 60 * 60 * 1000;
const mailUser = process.env.GMAIL_USER?.trim();
const mailPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
const contactEmail = process.env.CONTACT_EMAIL?.trim() || mailUser;

const transport = mailUser && mailPassword
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: mailUser,
            pass: mailPassword
        }
    })
    : null;

async function connectDatabase() {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');
}

connectDatabase().catch((err) => {
    console.error('MongoDB connection error:', err.message);
});

const bookSchema = new mongoose.Schema({
    title: String,
    author: String,
    price: Number,
    category: String,
    image: String,
    createdAt: { type: Date, default: Date.now }
});

const Book = mongoose.model('Book', bookSchema);

const transactionSchema = new mongoose.Schema({
    book: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Book',
        required: true
    },
    userName: {
        type: String,
        default: 'Guest'
    },
    status: {
        type: String,
        enum: ['borrowed', 'returned'],
        default: 'borrowed'
    },
    createdAt: { type: Date, default: Date.now },
    returnedAt: { type: Date, default: null }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function createAdminSessionToken(expiresAt) {
    const signature = crypto
        .createHmac('sha256', adminSessionSecret)
        .update(`admin:${expiresAt}`)
        .digest('hex');

    return `${expiresAt}.${signature}`;
}

function hasAdminSession(req) {
    const cookies = req.get('cookie') || '';
    const sessionCookie = cookies
        .split(';')
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith('admin_session='));

    if (!sessionCookie) {
        return false;
    }

    const token = sessionCookie.slice('admin_session='.length);
    const separatorIndex = token.indexOf('.');
    if (separatorIndex === -1) {
        return false;
    }

    const expiresAt = Number(token.slice(0, separatorIndex));
    const providedSignature = Buffer.from(token.slice(separatorIndex + 1), 'hex');
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        return false;
    }

    const expectedSignature = Buffer.from(createAdminSessionToken(expiresAt).split('.')[1], 'hex');
    return providedSignature.length === expectedSignature.length &&
        crypto.timingSafeEqual(providedSignature, expectedSignature);
}

function isAdmin(req, res, next) {
    if (hasAdminSession(req)) {
        return next();
    }

    return res.redirect('/admin/login');
}

app.use((req, res, next) => {
    res.locals.isAdmin = hasAdminSession(req);
    next();
});

app.get('/admin/login', (req, res) => {
    if (res.locals.isAdmin) {
        return res.redirect('/books/new');
    }

    res.render('admin-login.ejs', { error: '' });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username !== adminUsername || password !== adminPassword) {
        return res.status(401).render('admin-login.ejs', {
            error: 'The username or password is incorrect.'
        });
    }

    const expiresAt = Date.now() + adminSessionLifetime;
    res.cookie('admin_session', createAdminSessionToken(expiresAt), {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: adminSessionLifetime,
        path: '/'
    });
    return res.redirect('/books/new');
});

app.post('/admin/logout', (req, res) => {
    res.clearCookie('admin_session', { httpOnly: true, sameSite: 'strict', path: '/' });
    res.redirect('/');
});

async function getHomeStats() {
    const [totalBooks, activeBorrows] = await Promise.all([
        Book.countDocuments(),
        Transaction.countDocuments({ status: 'borrowed' })
    ]);

    return { totalBooks, activeBorrows };
}

app.get('/', async (req, res) => {
    const stats = await getHomeStats().catch(() => ({ totalBooks: 0, activeBorrows: 0 }));
    res.render('home.ejs', { stats });
});

app.get('/about', (req, res) => {
    res.render('about.ejs');
});

app.get('/books', async (req, res) => {
    const books = await Book.find().sort({ createdAt: -1 });
    res.render('books.ejs', { books });
});

app.get('/books/new', isAdmin, (req, res) => {
    res.render('newbook.ejs');
});

app.post('/books', isAdmin, upload.single('image'), async (req, res) => {
    try {
        const book = new Book({
            title: req.body.title,
            author: req.body.author,
            price: req.body.price,
            category: req.body.category,
            image: req.file ? '/uploads/' + req.file.filename : ''
        });

        await book.save();
        res.redirect('/books');
    } catch (error) {
        console.error('Error adding book:', error);
        res.status(500).send('Unable to add book.');
    }
});

app.get('/categories', async (req, res) => {
    const [books, categories] = await Promise.all([
        Book.find().sort({ createdAt: -1 }),
        Book.distinct('category', { category: { $nin: [null, ''] } })
    ]);
    res.render('categories.ejs', {
        books,
        categories: categories.sort(),
        selectedCategory: 'All Books'
    });
});

app.get('/categories/:category', async (req, res) => {
    const category = decodeURIComponent(req.params.category);
    const [books, categories] = await Promise.all([
        Book.find({ category }).sort({ createdAt: -1 }),
        Book.distinct('category', { category: { $nin: [null, ''] } })
    ]);
    res.render('categories.ejs', {
        books,
        categories: categories.sort(),
        selectedCategory: category
    });
});

app.get('/transactions', async (req, res) => {
    const [transactions, activeBorrows] = await Promise.all([
        Transaction.find().populate('book').sort({ createdAt: -1 }).lean(),
        Transaction.countDocuments({ status: 'borrowed' })
    ]);

    res.render('transactions.ejs', { transactions, activeBorrows });
});

app.post('/transactions/borrow/:id', async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.status(404).send('Book not found.');
        }

        const activeBorrow = await Transaction.findOne({
            book: book._id,
            status: 'borrowed'
        });

        if (activeBorrow) {
            return res.status(409).send('This book is already borrowed.');
        }

        await Transaction.create({
            book: book._id,
            userName: req.body.userName || 'Guest',
            status: 'borrowed'
        });

        res.redirect('/transactions');
    } catch (error) {
        console.error('Error borrowing book:', error);
        res.status(500).send('Unable to borrow book.');
    }
});

app.post('/transactions/return/:id', async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);

        if (!transaction) {
            return res.status(404).send('Transaction not found.');
        }

        if (transaction.status === 'returned') {
            return res.redirect('/transactions');
        }

        transaction.status = 'returned';
        transaction.returnedAt = new Date();
        await transaction.save();

        res.redirect('/transactions');
    } catch (error) {
        console.error('Error returning book:', error);
        res.status(500).send('Unable to return book.');
    }
});

app.get('/contact', (req, res) => {
    res.render('contact.ejs', {
        contactSent: req.query.sent === '1',
        contactError: ''
    });
});

app.post('/contact', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const mobile = typeof req.body.mobile === 'string' ? req.body.mobile.trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';

    if (!name || !email || !mobile || !message) {
        return res.status(400).render('contact.ejs', {
            contactSent: false,
            contactError: 'Please complete every field before sending your message.'
        });
    }

    if (!transport) {
        console.warn('Email sending is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD to enable it.');
        return res.status(503).render('contact.ejs', {
            contactSent: false,
            contactError: 'Email is temporarily unavailable. Please try again later.'
        });
    }

    try {
        await transport.sendMail({
            to: contactEmail,
            from: mailUser,
            replyTo: email,
            subject: `New contact message from ${name}`,
            text: `Name: ${name}\nEmail: ${email}\nMobile: ${mobile}\nMessage: ${message}`
        });

        res.redirect(303, '/contact?sent=1');
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).render('contact.ejs', {
            contactSent: false,
            contactError: 'We could not send your message. Please try again later.'
        });
    }
});

app.get('/books/edit/:id', isAdmin, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.send('Book not found.');
        }

        res.render('editbook.ejs', { book });
    } catch (err) {
        console.error('Error opening edit page:', err);
        res.send('Unable to edit book.');
    }
});

app.post('/books/edit/:id', isAdmin, upload.single('image'), async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);

        if (!book) {
            return res.send('Book not found.');
        }

        book.title = req.body.title;
        book.author = req.body.author;
        book.price = req.body.price;
        book.category = req.body.category;

        if (req.file) {
            book.image = '/uploads/' + req.file.filename;
        }

        await book.save();
        res.redirect('/books');
    } catch (err) {
        console.error('Error updating book:', err);
        res.send('Unable to update book.');
    }
});

app.post('/books/delete/:id', isAdmin, async (req, res) => {
    try {
        await Book.findByIdAndDelete(req.params.id);
        res.redirect('/books');
    } catch (err) {
        console.error('Error deleting book:', err);
        res.send('Unable to delete book.');
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});