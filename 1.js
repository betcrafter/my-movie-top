const firstPost = {
    author : 'Alex',
    sex: "male",
    age: 30
}

// const newPost = (post, postDate = Date()) => ({
//     ...post,
//     postDate
// })

const newPost = (post, postDate = Date()) => {
    return {
        ...post,
        postDate
    }
}

//console.table(newPost(firstPost))

const fnWithError = () => {
    throw new Error ('Some Error written by me')
}

try {
    fnWithError()
} catch (error) {
    console.error(error)
    console.log(error.message)
    console.log('Catch block is running')
}
console.log(`Continue`)