import express, { json, response } from "express";
import mongoose from "mongoose"
import 'dotenv/config'
import Blog from "./Schema/Blog.js"
import bcryptjs from "bcrypt";
import User from "./Schema/User.js"
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import cors from 'cors';
import admin from "firebase-admin"
import serviceAccountKey from "./reactjs-blog-4ca96-firebase-adminsdk-5w02u-e201b845b9.json" assert {type: "json"}
import { getAuth } from "firebase-admin/auth"
import { upload } from "./middleware/multer.js"
import Notification from "./Schema/Notification.js"
import Comment from "./Schema/Comment.js"

import { uploadOnCloudinary } from "./util/cloudinary.js";

const server = express();
let PORT = 3000



admin.initializeApp({
    credential: admin.credential.cert(serviceAccountKey)
})

server.use(express.json())
server.use(cors())

mongoose.connect(process.env.DB_LOCATION, {
    autoIndex: true
})

let emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
let passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

const verifyJWT = (req, res, next) => {

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(" ")[1];

    if(token == null){
        return res.status(401).json({ error: "No access token" })
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if(err) {
            return res.status(403).json({ error: "access token is invalid" })
        }

        req.user = user.id
        next()
    })

}

const formatDatatoSend = (user) => {

    const access_token = jwt.sign({ id: user._id }, process.env.JWT_SECRET)

    return {
        accessToken: access_token,
        profile_img: user.personal_info.profile_img,
        username: user.personal_info.username,
        fullname: user.personal_info.fullname
    }
}

const generateUsername = async (email) => {
    let username = email.split("@")[0]
    let isUsernameNotUnique = await User.exists({"personal_info.username": username}).then((result) => result)
    if(!isUsernameNotUnique){
        username += nanoid().substring(0, 5)
    } 
    return username
}

server.post("/signup", (req, res) => {
    let { fullname, email, password } = req.body;
    
        if(fullname.length < 3){
            return res.status(400).json({
                "error": "fullname must be longer than 3 letter"
            })
        }
    

    if(!emailRegex.test(email)){
        return res.status(403).json({
            "error": "Enter is Invalid"
        })
    }

    if(!passwordRegex.test(password)){
        return res.status(403).json({
            "error": "Password should be 6 to 20 characters long with a numeric, 1 lowercase and 1 uppercase letters"
        })
    }

    bcryptjs.hash(password, 10, async (error, hashed_pass) => {

        let username = await generateUsername(email)
        let user = new User({
            personal_info:{fullname, email, password: hashed_pass, username}
        })

        user.save().then((u) => {

            return res.status(200).json(formatDatatoSend(u))

        }).catch(err => {

            if(err.code == 11000){
                return res.status(500).json({"error": "email already exists"})
            }

            return res.status(500).json({
                "error": err.message
            })
        })

    })

})

server.post("/signin", (req, res) => {
    let { email, password } = req.body;
    console.log("first, ", email, password)
    User.findOne({"personal_info.email":email})
    .then((user) => {
        if(!user){
            console.log("email not found")
            return res.status(403).json({"error": "Email not found"})    
        }

        if(!user.google_auth){
            bcryptjs.compare(password, user.personal_info.password, (err, result)=>{
                if(err) {
                    console.log("error: ", err)
                    return res.status(403).json({'Error': "error occured while login please try again "})
                }
                if(!result) {
                    console.log("incorrect password")
                    return res.status(403).json({"error": "Incorrect password"})
                } else {
                    return res.status(200).json(formatDatatoSend(user))
                }
            })                                     
            
        } else{
            return res.status(403).json({"error": "Account was created using google. Try loggin in with google"})
        }
        
    })
    .catch(err => {
        console.log("newError, ", err);
        return res.status(500).json({"error": err.message})
    })
})

server.post("/google-auth", async (req, res)=>{
    let { accessToken } = req.body

    getAuth().verifyIdToken(accessToken).then(async (decodedUser)=>{
        let { email, name, picture } = decodedUser

        picture = picture.replace("s96-c", "s384-c")

        let user = await User.findOne({"personal_info.email":email}).select("personal_info.fullname personal_info.username personal_info.profile_img google_auth")
        .then((u)=>{
            console.log(u)
            return u || null
        }).catch(err=>{
            return res.status(500).json({"error": err.message})
        })

        if(user){
            if(!user.google_auth){
                return res.status(403).json({
                    "error": "This email was signed in without google"
                })
            }
        } else{
            let username = await generateUsername(email);

            user = new User({
                personal_info: { fullname: name, email, username },
                google_auth: true
            })

            await user.save().then((u) => {
                user = u;
            })
            .catch(err => {
                return res.status(500).json({"error": err.message})
            })
        }

        return res.status(200).json(formatDatatoSend(user))
    }).catch(err => {
        return res.status(500).json({
            "error": "Failed to authenticate. Try with another account"
        })
    })
})

server.post("/blog-editor/upload-img", upload.single('img'), async (req, res) => {
    try {
        const response = await uploadOnCloudinary(req.file.path);

        if (response) {
            console.log(response); // Log the URL
            res.json({ msg: "Item received", imageUrl: response });
        } else {
            res.status(500).json({ error: "Error uploading image" });
        }
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const sortArray = (blogs, following)=>{
    const followed = blogs.filter(blog => following.includes(blog.author.personal_info.username))
    const notFollowed = blogs.filter(blog => !following.includes(!blog.author.personal_info.username))
    return [...followed, ...notFollowed]
}

server.post('/latest-blogs', (req, res) => {
    let { page, accessToken } = req.body
    let maxLimit = 10
    let following = []
    
    if(accessToken){
        let user_id;
        jwt.verify(accessToken, process.env.JWT_SECRET, (err, user) => {
            if(err) {
                return res.status(403).json({ error: "access token is invalid" })
            }
    
            user_id = user.id
        })
        
        User.findOne({_id: user_id})
        .populate("follow.following", "personal_info.username")
        .then(result => {
            result.follow.following.map(obj=>{
                console.log(obj.personal_info.username)
                following.push(obj.personal_info.username)
            })
            Blog.find({ draft: false }).populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
            .sort({ "publishedAt": -1 })
            .select("blog_id title des banner activity tags publishedAt -_id")
            .skip((page - 1) * maxLimit)
            .limit(maxLimit)
            .then(blogs => {
                blogs = sortArray(blogs, following)
                return res.status(200).json({ blogs })
            })
            .catch(err => {
                console.log("error")
                return res.status(500).json({ error: err.message })
            })
        })
    } else {
        Blog.find({ draft: false }).populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
        .sort({ "publishedAt": -1 })
        .select("blog_id title des banner activity tags publishedAt -_id")
        .skip((page - 1) * maxLimit)
        .limit(maxLimit)
        .then(blogs => {
            blogs = sortArray(blogs, following)
            return res.status(200).json({ blogs })
        })
        .catch(err => {
            console.log("error")
            return res.status(500).json({ error: err.message })
        })
    }



   
})

server.get('/tending-blogs', (req, res)=>{
    Blog.find({ draft: false })
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "activity.total_reads": -1, "activity.total_likes": -1, "publishedAt": -1 })
    .select("blog_id title publishedAt -_id")
    .limit(5)
    .then(blogs => {
        return res.status(200).json({ blogs })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

server.post('/create-blog', verifyJWT ,(req, res) => {
    
    let authorId = req.user;

    let { title, banner, des, tags, content, draft = undefined, id } = req.body;

    if(!draft){
        if(!des.length || des.length > 200){
            return res.status(403).json({error: "You must provide blog description under 200 characters"})
        }
    
        if(!banner.length){
            return res.status(403).json({error: "You must provide a banner to publish the blog"})
        }
    
        if(!content.blocks.length){
            return res.status(403).json({error: "There must be some blog content to publish it"})
        }
    
        if(!tags.length || tags.length > 10){
            return res.status(403).json({error: "Provide tags in order to publish the blog , Maximum 10"})
        }
    }

    if(!title.length){
        return res.status(403).json({error: "You must provide a title"})
    }

    

    tags = tags.map(tag => tag.toLowerCase())

    let blog_id = id || title.replace(/[^a-zA-Z0-9]/g, ' ').replace(/\s+/g, "-").trim() + nanoid()

    if(id){

        Blog.findOneAndUpdate({ blog_id }, { title, des, banner, content, tags, draft: draft ? draft : false })
        .then(() => {
            return res.status(200).json({id: blog_id})
        })
        .catch(err=>{
            return res.status(500).json({error: err.message})
        })
    } else{
        let blog = new Blog({
            title, des, banner, content, tags, author: authorId, blog_id, draft: Boolean(draft)
        })
    
        blog.save().then(blog => {
            let incrementVal = draft ? 0 : 1;
    
            User.findOneAndUpdate({ _id: authorId }, {
                $inc: { "account_info.total_posts" : incrementVal }, $push: { "blogs": blog._id }
            }).then(user => {
                return res.status(200).json({ id: blog.blog_id })
            })
            .catch((err) => {
                return res.status(500).json({ error: "failed to update total posts number" })
            })
    
        })
        .catch(err => {
            return res.status(500).json({ error: err.message })
        })
    }

    
    
    // return res.json({status: "done"})

})

server.post('/search-blogs', async (req, res)=>{

    let { tag, query, page, author, limit, eliminate_blog } = req.body

    let findQuery

    if(tag){
        findQuery = { tags: tag, draft: false, blog_id: {$ne: eliminate_blog} }
    }

    else if(query){
        findQuery = { draft: false, title: new RegExp(query, 'i')}
    } else if(author){
        findQuery = { author, draft: false }
    }

    let maxLimit = limit ? limit : 10
    
    Blog.find(findQuery)
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "publishedAt": -1 })
    .select("blog_id title des banner activity tags publishedAt -_id")
    .skip((page-1)*maxLimit)
    .limit(maxLimit)
    .then(blogs => {
        return res.status(200).json({ blogs })
    })
    .catch(err => {
        return res.status(500).json({ error: err.message })
    })

})

server.post('/all-latest-blogs-count', (req, res)=>{
    Blog.countDocuments({ draft: false })
    .then(count => {
        return res.status(200).json({ totalDocs: count })
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({error: err.message}) 
    })
})

server.post('/search-blogs-count', (req, res)=>{
    let { tag, query, author } = req.body

    let findQuery
    if(tag){
        findQuery = { tags: tag, draft: false }
    } else if(query){
        findQuery = { draft: false, title: new RegExp(query, 'i')}
    } else if(author){
        findQuery = { author, draft: false }
    }

    Blog.countDocuments(findQuery)
    .then(count => {  
        return res.status(200).json({ totalDocs: count })
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({ error: err.message })
    })
})

server.post('/search-users', (req, res)=>{

    let { query } = req.body

    User.find({ "personal_info.username": new RegExp(query, 'i') }).limit(50)
    .select("personal_info.fullname personal_info.username personal_info.profile_img -_id ")
    .then(users => {
        return res.status(200).json({
            users
        })
    })
    .catch(err => {
        res.status(500).json({
            error: err.message
        })
    })

})

server.post('/get-minimal-profile', async ( req, res)=>{
    let { userId } = req.body

    User.findOne({_id: userId})
    .select("personal_info.fullname personal_info.username personal_info.profile_img")
    .then(user => {
        return res.status(200).json({user})
    })
    .catch(err => {
        console.log(err)
        res.status(500).json({error: err.message})
    })
})

server.post('/get-profile', async (req, res)=>{
    let {username} = req.body
    User.findOne({ "personal_info.username": username })
    .select("-personal_info.password -google_auth -updatedAt -blogs")
    .populate("follow", "followed_by.username following.username")
    .then(user=>{
        return res.status(200).json({user})
    })
    .catch(err => {
        console.log(err)
        res.status(500).json({err: err.message})
    })
   
})

server.post('/get-following', verifyJWT, (req, res)=>{
    let user_id = req.user

    User.findOne({_id: user_id})
    .select("follow")
    .populate("follow", "following.username")
    .then(user => {
        return res.status(200).json({user})
    })
    .catch(err => {
        console.log(err)
        res.status(500).json({error: err.message})
    })

})

server.post("/get-blog", (req, res)=>{
    let { blog_id, draft, mode } = req.body

    let incrementVal = mode != 'edit' ? 1 : 0;

    Blog.findOneAndUpdate({ blog_id }, { $inc : { "activity.total_reads": incrementVal } })
    .populate("author", "personal_info.fullname personal_info.username personal_info.profile_img")
    .select("title des content banner activity publishedAt blog_id tags")
    .then(blog => {
        User.findOneAndUpdate({ "personal_info.username": blog.author.personal_info.username }, { $inc: { "account_info.total_reads": incrementVal } })
        .catch(err => {
            res.status(500).json({ error: err.message })
        })

        if(blog.draft && !draft){
            return res.status(500).json({ error: "you can not access draft blogs" })
        }
        console.log(blog)

        return res.status(200).json({ blog })

    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

server.post("/like-blog", verifyJWT, (req, res) => {
    
    let user_id = req.user;

    let { _id, isLikedByUser } = req.body
    
    let incrementVal = !isLikedByUser ? 1 : -1

    Blog.findOneAndUpdate({ _id },  { $inc: { "activity.total_likes": incrementVal } })
    .then(blog => {
        if(!isLikedByUser){
            let like = new Notification({
                type: "like",
                blog:_id,
                notification_for: blog.author,
                user: user_id
            })

            like.save().then(notification =>{
                return res.status(200).json({liked_by_user: true})
            })
        } else {

            Notification.findOneAndDelete({ user: user_id, blog: _id, type: "like" })
            .then(data => {
                return res.status(200).json({liked_by_user: false})
            })
            .catch(err => {
                return res.status(500).json({error: err.message})
            })
        }
    })
})

server.post("/is-liked-by-user", verifyJWT, (req, res) => {
    let user_id = req.user;
    let { _id } = req.body

    Notification.exists({ user: user_id, type: "like", blog: _id})
    .then(result => {
        return res.status(200).json({ result })
    })
    .catch(err => {
        res.status(500).json({ error: err.message})
    })
})

server.post("/add-comment", verifyJWT, (req, res)=>{

    let user_id = req.user;

    let { _id, comment, blog_author, replyingTo, notification_id } = req.body;

    if(!comment.length) {
        return res.status(403).json({ error: "Write something to leave a comment" })
    }

    //creating a comment doc
    let commentObj = {
        blog_id: _id,
        blog_author,
        comment,
        commented_by: user_id,
        isReply: replyingTo ? true : false
    }

    if(replyingTo){
        commentObj.parent = replyingTo
    }

    new Comment(commentObj).save().then(async commentFile => {
        let { comment, commentedAt, children } = commentFile

        Blog.findOneAndUpdate({_id}, { $push: { "comments": commentFile._id }, $inc : {"activity.total_comments": 1, "activity.total_parent_comments": replyingTo? 0 : 1}  })
        .then(blog => { console.log('New comment Created')})

        if(replyingTo){
            console.log(replyingTo)
        }

        let notificationObj = {
            type: replyingTo ? "reply" : "comment",
            blog: _id,
            notification_for: blog_author,
            user: user_id,
            comment: commentFile._id
        }

        if(replyingTo){

            notificationObj.replied_on_comment = replyingTo

            await Comment.findOneAndUpdate({ _id: replyingTo }, { $push: { children: commentFile._id } } )
            .then(replyingToComment => { notificationObj.notification_for = replyingToComment.commented_by })

            if(notification_id){
                Notification.findOneAndUpdate({ _id: notification_id }, {reply: commentFile._id})
                .then(notification => console.log('notification updated'))
            }

        }

        new Notification(notificationObj).save().then(notification => console.log('new notification created'))

        return res.json({comment, commentedAt, _id: commentFile._id, user_id, children})
    })
})

server.post("/get-blog-comments", (req, res)=>{
    let { blog_id, skip } = req.body

    let maxLimit = 5;

    Comment.find({ blog_id, isReply: false })
    .populate("commented_by", "personal_info.username personal_info.fullname personal_info.profile_img")
    .skip(skip)
    .limit(maxLimit)
    .sort({
        'commentedAt': -1
    })
    .then(comment => {
        return res.status(200).json(comment)
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({error: err.message})
    })
})

server.post("/get-replies", (req, res)=>{
    let { _id, skip } = req.body

    let maxLimit = 5;

    Comment.findOne({_id})
    .populate({
        path: "children",
        options: {
            limit: maxLimit,
            skip: skip,
            sort: { 'commentedAt': -1 }
        },
        populate: {
            path: 'commented_by',
            select: "personal_info.profile_img personal_info.fullname personal_info.username" 
        },
        select: "-blog_id -updatedAt"
    })
    .select("children")
    .then(doc => {
        return res.status(200).json({ replies: doc.children })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

const deleteComment = (_id) => {
    Comment.findOneAndDelete({_id})
    .then(comment => {

        if(comment.parent){
            Comment.findOneAndUpdate({ _id: comment.parent }, {$pull: { children: _id }})
            .then(data => console.log('comment delete from parent'))
            .catch(err => console.log(err)) 
        }

        Notification.findOneAndDelete({ comment: _id })
        .then(notification => console.log('comment notification deleted'))

        Notification.findOneAndUpdate({reply: _id}, {$unset: { reply: 1 }}).then(notification => console.log('reply notification deleted'))

        Blog.findOneAndUpdate({_id: comment.blog_id}, { $pull: {comments: _id}}, {$inc: {'activity.total_parent_comments': -1, 'activity.total_parent_comments': comment.parent ? 0 : -1}})
        .then(blog => {
            if(comment.children.length){
                comment.children.map(replies => {
                    deleteComment(replies)
                })
            }
        })

    })
    .catch(err => {
        console.log(err.message)
    })
}

server.post('/delete-comment', verifyJWT , (req, res) => {

    let user_id = req.user
    let { _id } = req.body

    Comment.findOne({_id})
    .then(comment=>{
        if(user_id == comment.commented_by || user_id == comment.blog_author){

            deleteComment(_id)

            return res.status(200).json({ status: "done" })

        } else {
            console.log("no delete")
            return res.status(403).json({error: "You can no delete this comment"})
        }
    })

})

server.post("/change-password", verifyJWT, (req, res) => {

    let { currentPassword, newPassword } = req.body

    if(!passwordRegex.test(currentPassword) || !passwordRegex.test(newPassword)){
        return res.status(403).json({error: "Password should be 6 to 20 characters long with a numeric, 1 lowercase and 1 uppercase letters"})
     }

     User.findOne({ _id: req.user })
     .then((user) => {
        if(user.google_auth){
            return res.status(403).json({
                error: "You can't change accounts password coz you logged in throught google"
            })
        }

        bcryptjs.compare(currentPassword, user.personal_info.password, (err, result) => {
            if(err) {
                return res.status(500).json({error: "Some error occured while changing the password, please try again later"})
            }

            if(!result){
                return res.status(403).json({error: "Incorrect current password"})
            }

            bcryptjs.hash(newPassword, 10, (err, hashed_pass) => {
                User.findOneAndUpdate({_id: req.user}, { "personal_info.password": hashed_pass })
                .then((u) => {
                    return res.status(200).json({status: "password Changed"})
                })
                .catch(err => {
                    return res.status(500).json({error: "Some error occrued while saving new password, please try again later"})
                })
            })

        })

     })
     .catch(err => {
        console.log(err)
        res.status(500).json({error: "User not found"})
     })

})

server.post("/update-profile-img", verifyJWT, async (req, res) => {
    let { url } = req.body

    User.findOneAndUpdate({ _id: req.user }, {"personal_info.profile_img": url} )
    .then(() => {
        return res.status(200).json({ profile_img: url })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })

})

server.post("/update-profile", verifyJWT, (req, res)=>{
    let { username, bio, social_links } = req.body;

    let bioLimit = 150;

    if(username.length < 3){
        return res.status(403).json({error: "Username should be atleast three letter long"})
    }

    if(bio.length > bioLimit){
        return res.status(403).json({error: `Bio should not be more than ${bioLimit} characters`})
    }

    let socialLinksArr = Object.keys(social_links);

    try {
        
        for(let i = 0; i < socialLinksArr.length; i++){
            if(social_links[socialLinksArr[i]].length){
                let hostname = new URL(social_links[socialLinksArr[i]]).hostname;       

                if(!hostname.includes(`${socialLinksArr[i].com}`) && socialLinksArr[i] != 'website'){
                     return res.status(403).json({error: `${socialLinksArr[i]} link is invalid. You must enter a full link`})
                }
            }
        }

    } catch (error) {
        return res.status(500).json({error: "You must provide full social links with https(s) included"})
    }

    let UpdateObj = {
        "personal_info.username": username,
        "personal_info.bio": bio,
        social_links
    }

    User.findOneAndUpdate({_id: req.user}, UpdateObj, {
        runValidators: true
    })
    .then(()=>{
        return res.status(200).json({ username })
    })
    .catch(err => {
        if(err.code == 1100){
            return res.status(409).json({error: "Username is already taken"})
        }
        return res.status(500).json({error: err.message})
    })

})

server.get("/new-notification", verifyJWT, (req, res)=>{

    let user_id = req.user;

    Notification.exists({ notification_for: user_id, seen: false, user: { $ne: user_id } })
    .then(result => {
        if( result ){
            return res.status(200).json({ new_notification_available: true })
        } else {
            return res.status(200).json({ new_notification_available: false })
        }
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({ error: err.message })
    })

})

server.post("/notifications", verifyJWT, (req, res)=>{
    let user_id = req.user
    let { page, filter, deletedDocCount } = req.body

    let maxLimit = 10;

    let findQuery = { notification_for: user_id, user: {$ne: user_id} }

    let skipDocs = (page-1)*maxLimit

    if( filter != 'all' ){
        findQuery.type = filter
    }

    if(deletedDocCount){
        skipDocs -= deletedDocCount
    }

    
    let query =  Notification.find(findQuery)
        .skip(skipDocs)
        .limit(maxLimit)
        .populate("user", "personal_info.fullname personal_info.username personal_info.profile_img")
        .sort({ createdAt: -1 })
        .select(" createdAt type seen reply ")
    if(filter == 'all' || filter == 'filter'){
        query = query.populate("blog", "title blog_id")
        .populate("comment", "comment")
        .populate("replied_on_comment", "comment")
        .populate("reply", "comment")
    }

        query.then(notifications => {
            Notification.updateMany(findQuery, {seen: true})
            .skip(skipDocs)
            .limit(maxLimit)
            .then(()=>{
                console.log('notification seen')
            })
            return res.status(200).json({notifications})

        })
        .catch(err => {
            console.log(err.message)
            return res.json(500).json({ error: err.message })
        })
    

    
})

server.post("/all-notifications-count", verifyJWT, (req, res) => {
    let user_id = req.user

    let { filter } = req.body
    
    let findQuery = { notification_for: user_id, user: {$ne: user_id} }

    if(filter != 'all'){
        findQuery.type = filter
    }

    Notification.countDocuments(findQuery)
    .then(count => {
        return res.status(200).json({ totalDocs: count })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})


server.post("/user-written-blogs", verifyJWT, (req, res) => {
    let user_id = req.user;

    let { page, draft, query, deletedDocCount } = req.body

    let maxLimit = 5;

    let skipDocs = (page-1)*maxLimit

    if(deletedDocCount){
        skipDocs -= deletedDocCount
    }

    Blog.find({ author: user_id, draft, title: new RegExp(query, 'i') })
    .skip(skipDocs)
    .limit(maxLimit)
    .sort({ publishedAt: -1 })
    .select(" title banner publishedAt blog_id activity des draft -_id ")
    .then(blog =>{
        return res.status(200).json({ blog })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })

})

server.post("/user-written-blogs-count", verifyJWT, (req, res)=>{
    let user_id = req.user

    let { draft, query } = req.body

    Blog.countDocuments({author: user_id, title: new RegExp(query, 'i')})
    .then(count => {
        return res.status(200).json({totalDocs: count})
    })
    .catch(err => {
        console.log(err.message)
        return res.status(500).json({error: err.message})
    })
})

server.post("/delete-blog", verifyJWT, (req, res)=>{

    let user_id = req.user;

    let { blog_id } = req.body;

    Blog.findOneAndDelete({ blog_id })
    .then(blog => {
        
        Notification.deleteMany({blog: blog._id}).then(data => console.log("notificaiotns deleted"))

        Comment.deleteMany({ blog_id: blog._id }).then(data => console.log("comments deleted"))

        User.findOneAndUpdate({_id: user_id}, { $pull: { blog: blog._id }, $inc: { "account_info.total_posts": -1 } })
        .then(user => console.log("blog deleted"))

        return res.status(200).json({status: 'done'})

    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })

})

server.post('/handle-unfollow', verifyJWT, (req, res)=>{
    let user_id = req.user

    let { profile_id } = req.body

    User.findOneAndUpdate({ _id: user_id }, { $pull: { "follow.following": profile_id } }).then((me)=>{
        User.findOneAndUpdate({ _id: profile_id }, { $pull: { "follow.followed_by": user_id } }).then(()=>{
            return res.status(200).json({"data": me})
        })
        
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})

server.post('/handle-follow', verifyJWT, (req, res)=>{

    let user_id = req.user

    let { profile_id } = req.body

    

    User.findOneAndUpdate({ _id: user_id }, { $push: { "follow.following": profile_id } }).then(()=>{
        User.findOneAndUpdate({ _id: profile_id }, { $push: { "follow.followed_by": user_id } }).then(()=>{

            let follow = new Notification({
                type: "follow",
                notification_for: profile_id,
                user: user_id
            })

            follow.save().then(notification => console.log(notification))

            return res.status(200).json({"success": true})

        })
    })
    .catch(err => {
        return res.status(500).json({error: err.message})
    })
})


server.listen(PORT, ()=>{
    console.log("listening on port ", PORT)
})















